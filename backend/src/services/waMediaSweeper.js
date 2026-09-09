import fsp from 'node:fs/promises';
import path from 'node:path';
import { tdb } from '../config/database.js';
import { DATA_DIR } from '../config/paths.js';
import { forSoleTenant } from '../config/tenantJobs.js';
import { MEDIA_DIR } from './waMediaService.js';
import WhatsAppConfigService from './whatsappConfigService.js';
import WaHealthService from './waHealthService.js';

/**
 * The only thing in this integration that deletes.
 *
 * Nothing else ever does: every attachment that arrives and every one the
 * operator sends is written under `DATA_DIR/wa-media/` and stays there, with no
 * quota and no count. On a provider with movement that grows on its own, and
 * the disk it fills is the same one SQLite writes to — so the panel does not
 * get slow, it stops.
 *
 * What the sweep may touch is deliberately narrow, and each limit is a rule
 * somebody would otherwise learn the hard way:
 *
 * - It deletes the FILE and clears that row's `attachment_*` columns. The
 *   message stays in the thread with its text intact and the bubble says the
 *   attachment is no longer on disk, which is true and already has a screen.
 * - It NEVER deletes a message row. Conversation history is what a provider
 *   needs when a customer disputes a charge; disk is what they need when it
 *   fills. Only one of those is this module's problem.
 * - It NEVER deletes a file a `queued` or `sending` message still has to send.
 *   The row's age is irrelevant: what matters is whether it has gone out.
 *   Deleting there turns a pending send into a permanent failure, and the
 *   operator who attached the file never finds out why.
 * - A file with no row pointing at it is an abandoned upload — the operator
 *   who attached a photo and closed the tab — and goes by the same age rule.
 *
 * With `mediaRetentionDays` at 0 it deletes nothing and says so. Zero is the
 * default, and that default is not laziness: the setting arrives at
 * installations that already have files, and deleting a provider's history
 * because they updated the panel would be the panel destroying data nobody
 * asked it to touch.
 */

/**
 * How often the loop wakes: four times a day.
 *
 * Nothing like the outbox's five seconds, and for the opposite reasons. The
 * window this job enforces is measured in DAYS, so a pass that runs six hours
 * "late" is still exact to well inside a percent of the shortest useful
 * retention — there is no reply waiting on it. A pass also walks the whole
 * media tree and stats every file on it, which is disk work competing for the
 * same spindle SQLite is using; doing that every minute would spend more of the
 * disk than the files it reclaims. And it is the one job here that destroys
 * data: a rare pass bounds how much a bug in it can take before anyone notices.
 */
const TICK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Ten years, the same ceiling `whatsappConfigService` clamps the setting to. */
const MAX_RETENTION_DAYS = 3650;

/** A row with one of these still has a send in front of it. */
const PENDING_STATUSES = ['queued', 'sending'];

/** Every stored attachment lives under here, and the walk never leaves it. */
const ROOT = path.resolve(DATA_DIR);

/** The subtree the sweep is allowed to delete from. */
const MEDIA_ROOT = path.resolve(ROOT, MEDIA_DIR);

/** Whether `candidate` is `root` itself or something inside it. */
function inside(root, candidate) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/** Megabytes with two decimals — the unit the operator's message speaks. */
export function toMb(bytes) {
  return Math.round((bytes / (1024 * 1024)) * 100) / 100;
}

/**
 * Days of retention, or zero for forever.
 *
 * Read defensively rather than trusted: anything unreadable — an absent key, a
 * string, a negative — reads as zero, and zero deletes nothing. The safe
 * direction for a number this destructive is always the one that keeps files.
 */
export function retentionDays(config) {
  const days = Math.trunc(Number(config?.mediaRetentionDays));
  if (!Number.isFinite(days) || days <= 0) return 0;
  return Math.min(days, MAX_RETENTION_DAYS);
}

/**
 * The absolute path a stored `attachment_path` names, or null.
 *
 * The same confinement `waMediaFile.resolveStoredAttachment` performs before it
 * opens anything, for the same reason and in the same order: `path.resolve`
 * collapses `..` BEFORE the prefix is checked, which is the only order that
 * works. A stored path landing outside `DATA_DIR` is not a file we have — it
 * protects nothing here and it matches nothing, exactly as it serves nothing
 * there.
 *
 * It resolves lexically and never calls `realpath`, unlike that module, and it
 * has to: these strings are compared against the ones the walk below produces,
 * and the walk is lexical too. One file reached two ways has to come out as one
 * string, or a protected file could fail to match itself.
 */
function absoluteFor(relative) {
  const stored = String(relative || '').trim();
  if (!stored) return null;
  const absolute = path.resolve(ROOT, stored);
  return inside(ROOT, absolute) ? absolute : null;
}

/**
 * Every regular file under `MEDIA_ROOT`, as absolute paths.
 *
 * Scoped to `wa-media` and not to `DATA_DIR`, which is the whole difference
 * between a media sweep and a panel that deletes its own database:
 * `panel.sqlite` and `db-config.json` live one directory up.
 *
 * Symlinks are skipped, files and directories alike — nothing in here was
 * written by this panel, and following one is how a sweep confined to a subtree
 * deletes something outside it. Anything that is not a regular file is left
 * alone for the same reason.
 */
async function walk(dir, out = []) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    // No media directory yet, or one that cannot be read. Either way there is
    // nothing here to delete, and a sweep is not the place to raise it.
    return out;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

class WaMediaSweeper {
  static timer = null;

  /**
   * Guards against two passes at once.
   *
   * A pass is slow by nature, and the manual button exists precisely for the
   * moment the disk is full — which is the moment an operator presses it twice.
   * Two passes would race on the same unlink and double-count the megabytes
   * they each claim to have freed.
   */
  static running = false;

  /**
   * Started from `server.js` only, never as an import side effect, so the test
   * suite never has a timer running behind it. Like the outbox and the alert
   * scan, the setting is read INSIDE the tick rather than used to start and
   * stop the timer: turning retention on in Settings takes effect on its own,
   * with no lifecycle to keep in sync.
   *
   * There is no pass at boot, on purpose. The one thing worse than a sweep with
   * a bug in it is a sweep with a bug in it that runs on every restart — and an
   * operator who needs disk right now has a button that does not wait.
   */
  static start() {
    if (this.timer) return this.timer;
    this.timer = setInterval(() => {
      // `tick` swallows its own failures; this catch exists only so a bug in
      // that promise chain cannot become an unhandled rejection.
      void this.tick().catch((error) => {
        console.warn(`WhatsApp media sweep failed: ${error.message}`);
      });
    }, TICK_INTERVAL_MS);
    this.timer.unref();
    return this.timer;
  }

  static stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One wake-up, in the installation's provider.
   *
   * `forSoleTenant`, like the alert scan, and here the reason is the disk
   * itself: the walk reads one filesystem, of which no provider owns a corner.
   * Run once per provider it would not divide the work, it would repeat it —
   * and worse, the second provider's pass would see the first provider's files
   * as orphans with no row pointing at them and delete every one of them. So it
   * refuses the moment a second provider goes live, which is the safer of the
   * two failures: a sweep that stops is a disk that fills, and a full disk is
   * noticed and fixed. The fix when that day comes is to give stored media a
   * per-provider subtree, and only then a per-provider loop.
   *
   * The blind spot this leaves is a provider whose `tenants` row is not
   * `active`: its messages are invisible to the scoped read below, so its files
   * would be judged as orphans. Nothing in the panel creates such a provider
   * today, and the fix for it is that same subtree.
   */
  static async tick() {
    try {
      return (await forSoleTenant('The WhatsApp media sweep', () => this.sweep()))
        ?? { skipped: 'no_provider', files: 0, bytes: 0, mb: 0 };
    } catch (error) {
      console.warn(`WhatsApp media sweep failed: ${error.message}`);
      return { skipped: 'unscoped', files: 0, bytes: 0, mb: 0 };
    }
  }

  /**
   * One pass, inside a provider scope the caller has already opened.
   *
   * It NEVER throws. A file another process removed between the walk and the
   * unlink, a directory the panel cannot read, a row whose path escapes
   * `DATA_DIR` — none of those may stop the pass, because the file after them
   * is the one that would have freed the disk. Why a pass did nothing comes
   * back in `skipped` instead, so the caller — the loop, or the admin who just
   * pressed the button — can tell "retention is off" from "nothing was old".
   *
   * @returns {Promise<{ files: number, bytes: number, mb: number, skipped?: string }>}
   */
  static async sweep() {
    if (this.running) return { skipped: 'busy', files: 0, bytes: 0, mb: 0 };
    this.running = true;
    try {
      const config = await WhatsAppConfigService.getConfig().catch(() => null);
      const days = retentionDays(config);
      // Zero is forever, and forever is the default. The pass stops here,
      // BEFORE the walk: with retention off there is nothing to look at, and
      // an operator pressing the button gets told that instead of a silent
      // "0 files" they would reasonably read as a bug.
      if (days === 0) return { skipped: 'disabled', files: 0, bytes: 0, mb: 0 };

      const cutoff = Date.now() - days * DAY_MS;
      const { protect, rowsByPath } = await this.indexRows();
      const files = await walk(MEDIA_ROOT);

      let deleted = 0;
      let bytes = 0;
      const clearable = [];

      for (const file of files) {
        // A file some `queued` or `sending` row still has to send is kept
        // whatever its age. This is the check the whole module is built
        // around: everything else here costs disk, and getting this one wrong
        // costs a message the operator believes they sent.
        if (protect.has(file)) continue;

        let stat;
        try {
          stat = await fsp.stat(file);
        } catch {
          continue;
        }
        // The clock is the file's own mtime, for attached files and orphans
        // alike. It is the number the disk itself keeps, it is the only one an
        // orphan has at all, and for a file with a row it is within seconds of
        // that row's `created_at` by construction — the bytes are written and
        // then the row is. One clock, so a file and the row pointing at it can
        // never disagree about how old they are.
        if (stat.mtimeMs > cutoff) continue;

        try {
          await fsp.unlink(file);
        } catch {
          // Gone already, or a permission the panel does not have. Neither is
          // reclaimed disk, so neither is counted.
          continue;
        }
        deleted += 1;
        bytes += stat.size;
        const rows = rowsByPath.get(file);
        if (rows) clearable.push(...rows);
      }

      // Bookkeeping last, and only for files that are actually gone: a row
      // cleared before an unlink that then failed would tell the operator the
      // attachment is off the disk while it is still sitting on it.
      await this.clearAttachments(clearable);

      // The health strip caches its disk reading for five minutes, which is
      // right for a poll and wrong immediately after a deletion: an operator
      // who presses "delete the old ones", frees two gigabytes and then reads
      // the same number as before has been told the sweep did nothing.
      if (deleted > 0) WaHealthService.forgetMedia();

      return { files: deleted, bytes, mb: toMb(bytes) };
    } catch (error) {
      console.warn(`WhatsApp media sweep failed: ${error.message}`);
      return { skipped: 'failed', files: 0, bytes: 0, mb: 0 };
    } finally {
      this.running = false;
    }
  }

  /**
   * One read of every row carrying an attachment, turned into the two things a
   * pass needs: which files are spoken for, and which rows to clear when a file
   * goes.
   *
   * One query rather than a lookup per file. The alternative — asking the
   * database about each file on disk — is thousands of round trips on the
   * installation this job exists for, which is precisely the one with the most
   * files.
   *
   * Two rows may name the same file, so the map holds a LIST of ids: clearing
   * only the first would leave the second pointing at bytes that are gone.
   */
  static async indexRows() {
    const rows = await tdb('wa_messages')
      .whereNotNull('attachment_path')
      .select('id', 'attachment_path', 'delivery_status');

    const protect = new Set();
    const rowsByPath = new Map();
    for (const row of rows) {
      const absolute = absoluteFor(row.attachment_path);
      if (!absolute) continue;
      if (PENDING_STATUSES.includes(row.delivery_status)) protect.add(absolute);
      const known = rowsByPath.get(absolute);
      if (known) known.push(row.id);
      else rowsByPath.set(absolute, [row.id]);
    }
    return { protect, rowsByPath };
  }

  /**
   * Clears the `attachment_*` columns of the rows whose file has just gone.
   *
   * An UPDATE and never a DELETE. The row is the message: its text, who sent
   * it, when it was delivered. What it loses is three columns describing a file
   * that no longer exists, which the thread already knows how to draw.
   *
   * Chunked because a `whereIn` with a five-figure list is a statement some
   * engines refuse to plan and SQLite refuses to parse.
   */
  static async clearAttachments(ids) {
    if (!ids.length) return 0;
    const patch = {
      attachment_path: null,
      attachment_type: null,
      attachment_name: null,
      updated_at: new Date()
    };
    let cleared = 0;
    for (let i = 0; i < ids.length; i += 200) {
      cleared += await tdb('wa_messages').whereIn('id', ids.slice(i, i + 200)).update(patch);
    }
    return cleared;
  }
}

export default WaMediaSweeper;
