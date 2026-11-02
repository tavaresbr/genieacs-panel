import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * O atualizador automático — provado rodando, e não lido.
 *
 * O que importa nele é o que ele decide e em que ordem chama as coisas: só sobe
 * para uma release publicada, nunca desce, não atualiza sem backup, e quando a
 * versão nova não sobe ele põe a anterior de volta e para de insistir nela.
 * Nada disso precisa de root nem de systemd para ser provado: o script roda
 * contra um install de mentira com um remoto de verdade, e o `skygenpanel` e o
 * backup são trocados por dublês que só anotam o que receberam.
 */

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(RAIZ, '..', 'deploy', 'skygenpanel-autoupdate');
const scratch = [];

const IDENTIDADE = {
  GIT_AUTHOR_NAME: 'Teste', GIT_AUTHOR_EMAIL: 'teste@example.invalid',
  GIT_COMMITTER_NAME: 'Teste', GIT_COMMITTER_EMAIL: 'teste@example.invalid'
};

function tmp(prefixo) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefixo));
  scratch.push(dir);
  return dir;
}

const git = (cwd, ...args) => execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], {
  cwd, encoding: 'utf8', env: { ...process.env, ...IDENTIDADE }, stdio: ['ignore', 'pipe', 'pipe']
}).trim();

const versao = (dir, v) => fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'panel', version: v }, null, 2)}\n`);

/**
 * Um remoto com duas releases e uma tag que não é release, e um install parado
 * na primeira, com `.env`, diretório de dados e os dois dublês.
 */
function montar({ instalada = '1.0.0', janela } = {}) {
  const base = tmp('skygp-auto-');
  const remoto = path.join(base, 'remoto.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remoto]);

  const semente = path.join(base, 'semente');
  fs.mkdirSync(semente);
  git(semente, 'init', '-q');
  git(semente, 'remote', 'add', 'origin', remoto);
  versao(semente, '1.0.0');
  git(semente, 'add', '-A');
  git(semente, 'commit', '-q', '-m', 'chore(release): v1.0.0');
  git(semente, 'tag', '-a', 'v1.0.0', '-m', 'v1.0.0');
  versao(semente, '1.1.0');
  git(semente, 'commit', '-q', '-am', 'chore(release): v1.1.0');
  git(semente, 'tag', '-a', 'v1.1.0', '-m', 'v1.1.0');
  git(semente, 'tag', '-a', 'v1.2.0-rc.1', '-m', 'não é release');
  git(semente, 'push', '-q', 'origin', 'main', '--tags');

  const install = path.join(base, 'install');
  execFileSync('git', ['clone', '-q', remoto, install], { stdio: 'ignore' });
  git(install, 'checkout', '-q', 'v1.0.0');
  versao(install, instalada);
  const dados = path.join(base, 'dados');
  fs.mkdirSync(dados);
  fs.mkdirSync(path.join(install, 'backend'));
  fs.writeFileSync(path.join(install, 'backend', '.env'),
    `DATA_DIR=${dados}\n${janela ? `AUTO_UPDATE_WINDOW=${janela}\n` : ''}`);

  const registro = path.join(base, 'chamadas.log');
  const cli = path.join(base, 'skygenpanel');
  fs.writeFileSync(cli, `#!/usr/bin/env bash
echo "cli $* lock=\${SKYGP_UPDATE_LOCK_HELD:-}" >> "${registro}"
for alvo in \${STUB_FALHA:-}; do [ "$2" = "$alvo" ] && exit 1; done
exit 0
`, { mode: 0o755 });
  const backup = path.join(base, 'skygenpanel-backup');
  fs.writeFileSync(backup, `#!/usr/bin/env bash
echo "backup $*" >> "${registro}"
exit \${STUB_BACKUP_SAIDA:-0}
`, { mode: 0o755 });

  return {
    base, remoto, semente, install, dados, registro,
    anterior: git(install, 'rev-parse', 'HEAD'),
    env: {
      ...process.env,
      SKYGP_DIR: install,
      SKYGP_CLI_PATH: cli,
      SKYGP_BACKUP_CLI_PATH: backup,
      SKYGP_UPDATE_LOCK: path.join(base, 'update.lock'),
      SKYGP_SKIP_ROOT_CHECK: '1'
    }
  };
}

function rodar(cenario, comando, extra = {}) {
  const r = spawnSync('bash', [SCRIPT, comando], { env: { ...cenario.env, ...extra }, encoding: 'utf8' });
  return { status: r.status, saida: `${r.stdout}${r.stderr}` };
}

const chamadas = (cenario) => (fs.existsSync(cenario.registro)
  ? fs.readFileSync(cenario.registro, 'utf8').trim().split('\n') : []);
const pulada = (cenario) => {
  const f = path.join(cenario.dados, 'auto-update.skip');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : null;
};

after(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

describe('o que o atualizador decide', () => {
  it('sobe para a release mais nova, ignorando o que não é release', () => {
    const r = rodar(montar(), 'check');
    assert.equal(r.status, 0, r.saida);
    assert.match(r.saida, /^decision=update$/m);
    assert.match(r.saida, /^target=v1\.1\.0$/m);
    assert.match(r.saida, /^installed=v1\.0\.0$/m);
  });

  it('não faz nada quando já está na mais nova', () => {
    const r = rodar(montar({ instalada: '1.1.0' }), 'check');
    assert.match(r.saida, /^decision=none$/m);
    assert.match(r.saida, /up to date/);
  });

  /** Quem rodou `skygenpanel update` à mão pode estar à frente da última tag. */
  it('nunca desce para uma release mais velha que a instalada', () => {
    const r = rodar(montar({ instalada: '1.2.0' }), 'check');
    assert.match(r.saida, /^decision=none$/m);
  });

  it('pula a release que falhou, mas não a seguinte', () => {
    const cenario = montar();
    fs.writeFileSync(path.join(cenario.dados, 'auto-update.skip'), 'v1.1.0\n');
    assert.match(rodar(cenario, 'check').saida, /^decision=none$/m);

    versao(cenario.semente, '1.2.0');
    git(cenario.semente, 'commit', '-q', '-am', 'chore(release): v1.2.0');
    git(cenario.semente, 'tag', '-a', 'v1.2.0', '-m', 'v1.2.0');
    git(cenario.semente, 'push', '-q', 'origin', 'main', 'v1.2.0');
    const r = rodar(cenario, 'check');
    assert.match(r.saida, /^decision=update$/m);
    assert.match(r.saida, /^target=v1\.2\.0$/m);
  });

  it('respeita a janela de horário, inclusive a que passa da meia-noite', () => {
    assert.match(rodar(montar({ janela: '3-6' }), 'check', { SKYGP_HOUR: '14' }).saida, /^decision=wait$/m);
    assert.match(rodar(montar({ janela: '3-6' }), 'check', { SKYGP_HOUR: '03' }).saida, /^decision=update$/m);
    assert.match(rodar(montar({ janela: '22-4' }), 'check', { SKYGP_HOUR: '23' }).saida, /^decision=update$/m);
    assert.match(rodar(montar({ janela: '22-4' }), 'check', { SKYGP_HOUR: '01' }).saida, /^decision=update$/m);
    assert.match(rodar(montar({ janela: '22-4' }), 'check', { SKYGP_HOUR: '12' }).saida, /^decision=wait$/m);
  });

  /** Um erro de digitação ali não pode significar "nunca mais atualiza" em silêncio. */
  it('recusa uma janela que não entende, em vez de nunca atualizar calado', () => {
    const r = rodar(montar({ janela: '3h-6h' }), 'check');
    assert.notEqual(r.status, 0);
    assert.match(r.saida, /AUTO_UPDATE_WINDOW must look like/);
  });
});

describe('o que o atualizador faz', () => {
  it('faz backup, atualiza para a release, e avisa o update que já tem a trava', () => {
    const cenario = montar();
    const r = rodar(cenario, 'run');
    assert.equal(r.status, 0, r.saida);
    assert.deepEqual(chamadas(cenario), ['backup run', 'cli update v1.1.0 lock=1']);
    assert.match(r.saida, /Updated to v1\.1\.0/);
    assert.equal(pulada(cenario), null);
  });

  it('não chama nada quando não há o que fazer', () => {
    const cenario = montar({ instalada: '1.1.0' });
    const r = rodar(cenario, 'run');
    assert.equal(r.status, 0, r.saida);
    assert.deepEqual(chamadas(cenario), []);
  });

  it('não atualiza sem backup', () => {
    const cenario = montar();
    const r = rodar(cenario, 'run', { STUB_BACKUP_SAIDA: '1' });
    assert.notEqual(r.status, 0);
    assert.deepEqual(chamadas(cenario), ['backup run']);
    assert.match(r.saida, /backup failed; not updating/);
  });

  /**
   * A versão nova não passou no health check: a anterior volta, pelo commit
   * exato em que estava, e a release ruim fica marcada para não ser tentada de
   * novo a cada quinze minutos.
   */
  it('volta para a versão anterior quando a nova não sobe, e pula a nova dali em diante', () => {
    const cenario = montar();
    const r = rodar(cenario, 'run', { STUB_FALHA: 'v1.1.0' });
    assert.notEqual(r.status, 0, 'uma reversão aparece como falha no systemd');
    assert.deepEqual(chamadas(cenario), [
      'backup run',
      'cli update v1.1.0 lock=1',
      `cli update ${cenario.anterior} lock=1`
    ]);
    assert.match(r.saida, /Rolled back to/);
    assert.equal(pulada(cenario), 'v1.1.0');

    const depois = montar();
    fs.copyFileSync(path.join(cenario.dados, 'auto-update.skip'), path.join(depois.dados, 'auto-update.skip'));
    rodar(depois, 'run');
    assert.deepEqual(chamadas(depois), [], 'a release pulada não é tentada de novo');
  });

  it('diz com todas as letras quando nem a reversão sobe', () => {
    const cenario = montar();
    const r = rodar(cenario, 'run', { STUB_FALHA: `v1.1.0 ${cenario.anterior}` });
    assert.notEqual(r.status, 0);
    assert.match(r.saida, /ROLLBACK FAILED/);
  });

  it('cede a vez quando outra atualização já está rodando', () => {
    const cenario = montar();
    const r = spawnSync('flock', [cenario.env.SKYGP_UPDATE_LOCK, 'bash', SCRIPT, 'run'], { env: cenario.env, encoding: 'utf8' });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /Another update is running/);
    assert.deepEqual(chamadas(cenario), []);
  });

  it('fora da janela, só espera', () => {
    const cenario = montar({ janela: '3-6' });
    const r = rodar(cenario, 'run', { SKYGP_HOUR: '14' });
    assert.equal(r.status, 0, r.saida);
    assert.deepEqual(chamadas(cenario), []);
  });
});
