import Tenant from '../models/Tenant.js';
import { getDb } from '../config/database.js';
import { seedDefaults } from '../config/seed.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

/**
 * The provider registry: create, list, suspend, reactivate.
 *
 * There is no delete, and that is a decision rather than an omission. The
 * scoped tables point at `tenants` WITHOUT a cascade, so removing a provider
 * that holds anything would fail on a foreign key — and the version that
 * succeeded would be worse, because it would take an ISP's devices, its
 * customers and its message history with it on one click. Suspending is the
 * operation, and unlike deleting it can be undone.
 */

/** The only two values `tenants.status` is allowed to take. */
export const TENANT_STATUSES = Object.freeze(['active', 'suspended']);

/**
 * The slug is the subdomain the panel will be reached at, so the rule is DNS's
 * rule and not a taste in identifiers:
 *
 *   - lowercase ASCII letters, digits and hyphens only;
 *   - first and last character alphanumeric, so no leading or trailing hyphen;
 *   - 3 to 63 characters, 63 being the maximum length of a DNS label.
 *
 * Uppercase is REJECTED rather than lowered, and a stray space rejected rather
 * than trimmed, because whoever creates the provider is about to tell an ISP
 * the address of their panel. A slug that is silently rewritten means the
 * address they were given is not the address they typed, and they find that out
 * from a browser that cannot resolve it. Refusing costs one retry and says
 * exactly what is wrong.
 */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SLUG_MIN_LENGTH = 3;
const SLUG_MAX_LENGTH = 63;

/**
 * Labels that cannot become a provider, because the deployment already answers
 * to them. Handing an ISP `www.panel.example` or `api.panel.example` would put
 * their panel where the marketing site or the API lives — a collision nobody
 * can fix afterwards without moving that ISP to a new address.
 */
const RESERVED_SLUGS = new Set([
  'www', 'api', 'app', 'admin', 'portal', 'mail', 'static', 'assets', 'cdn', 'status'
]);

const NAME_MAX_LENGTH = 128;

/** What is wrong with this slug, or null when nothing is. */
function slugProblem(slug) {
  if (slug.length < SLUG_MIN_LENGTH || slug.length > SLUG_MAX_LENGTH) {
    return `Slug must be between ${SLUG_MIN_LENGTH} and ${SLUG_MAX_LENGTH} characters`;
  }
  if (!SLUG_PATTERN.test(slug)) {
    return 'Slug must be lowercase letters, digits and hyphens, starting and ending with a letter or digit';
  }
  // A hyphen in the third and fourth position is reserved by RFC 5891: `xn--`
  // introduces a punycode label, and every other pair is held back for whatever
  // comes next. A resolver is entitled to read such a label as encoded.
  if (slug[2] === '-' && slug[3] === '-') {
    return 'Slug must not carry a hyphen in both the third and fourth position';
  }
  if (RESERVED_SLUGS.has(slug)) {
    return 'Slug is reserved by the deployment';
  }
  return null;
}

/** The provider as the console shows it: `operators` is how many people work there. */
function present(tenant, operators) {
  return {
    id: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
    status: tenant.status,
    operators,
    createdAt: tenant.created_at ?? null
  };
}

class PlatformController {
  static async listTenants(req, res) {
    try {
      const tenants = await Tenant.list();
      const counts = await Tenant.operatorCounts();
      return res.json(createResponse('Tenants retrieved successfully', {
        tenants: tenants.map((tenant) => present(tenant, counts.get(Number(tenant.id)) || 0))
      }));
    } catch (error) {
      console.error('List tenants error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to list providers', error.message)
      );
    }
  }

  /**
   * Creates a provider, seeded exactly as one created at boot would be.
   *
   * The two writes are one transaction on purpose. `seedDefaults` is what gives
   * a provider its settings and its copy of the equipment catalogue, and a
   * provider that exists without them does not fail loudly — it comes up with
   * no GenieACS address and with equipment detection that matches nothing, so
   * the panel merely looks broken to whoever was just handed it. Either both
   * happen or neither does.
   */
  static async create(req, res) {
    try {
      // Read exactly what was sent. `trim()` here would be the silent
      // normalisation the rule above exists to refuse.
      const slug = String(req.body?.slug ?? '');
      const name = String(req.body?.name ?? '').trim();

      const problem = slugProblem(slug);
      if (problem) {
        return res.status(400).json(createErrorResponse(problem));
      }
      if (name.length < 1 || name.length > NAME_MAX_LENGTH) {
        return res.status(400).json(
          createErrorResponse(`Name must be between 1 and ${NAME_MAX_LENGTH} characters`)
        );
      }
      if (await Tenant.findBySlug(slug)) {
        return res.status(409).json(createErrorResponse('Slug already taken'));
      }

      let id;
      try {
        await getDb().transaction(async (trx) => {
          id = await Tenant.create({ slug, name }, trx);
          // The whole-deployment pass, not a per-provider shortcut, and that is
          // the point: this is the same call the boot path makes, so a provider
          // minted at runtime is born through the code that mints one at boot
          // rather than through a second implementation that would drift from
          // it. It is idempotent — every provider that already has its settings
          // and a catalogue is skipped — so the cost is a handful of reads and
          // the guarantee is that there is only one way a provider comes into
          // existence.
          //
          // The transaction is passed rather than left to default to `getDb()`,
          // for the same reason `dbManagementService` passes the target of a
          // database switch: the new provider is not visible outside this
          // transaction yet, so seeding on another connection would not see it.
          await seedDefaults(trx);
        });
      } catch (error) {
        // Two writers racing on the same slug both pass the check above and one
        // loses on the unique index. Reading the table back tells the two apart
        // without having to recognise a constraint-violation error on three
        // different engines, and the loser gets the same 409 they would have
        // got a moment earlier.
        if (await Tenant.findBySlug(slug)) {
          return res.status(409).json(createErrorResponse('Slug already taken'));
        }
        throw error;
      }

      const created = await Tenant.findById(id);
      return res.status(201).json(createResponse('Tenant created successfully', {
        tenant: present(created, 0)
      }));
    } catch (error) {
      console.error('Create tenant error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to create the provider', error.message)
      );
    }
  }

  /**
   * Suspends or reactivates a provider.
   *
   * `tenants.status` already means something everywhere in the panel:
   * `forEachTenant` visits only `active`, the media sweep walks past a
   * suspended provider, and the SGP webhook refuses a delivery for one. This
   * route does not invent that behaviour, it hands somebody the switch.
   *
   * Suspending is deliberately not a lockout: nothing in the sign-in path reads
   * this column, so a provider whose service has stopped can still be looked at
   * and, more importantly, turned back on.
   */
  static async setStatus(req, res) {
    try {
      const id = Number(req.params?.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json(createErrorResponse('Invalid provider id'));
      }
      const status = req.body?.status;
      if (!TENANT_STATUSES.includes(status)) {
        return res.status(400).json(
          createErrorResponse(`Status must be one of: ${TENANT_STATUSES.join(', ')}`)
        );
      }

      const tenant = await Tenant.findById(id);
      if (!tenant) {
        return res.status(404).json(createErrorResponse('Provider not found'));
      }

      await Tenant.setStatus(id, status);
      const updated = await Tenant.findById(id);
      const counts = await Tenant.operatorCounts();
      return res.json(createResponse('Tenant updated successfully', {
        tenant: present(updated, counts.get(Number(id)) || 0)
      }));
    } catch (error) {
      console.error('Update tenant error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to update the provider', error.message)
      );
    }
  }
}

export default PlatformController;
