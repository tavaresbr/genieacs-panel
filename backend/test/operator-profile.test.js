import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  authHeaders,
  call,
  defaultTenantId,
  getDb,
  startTestServers,
  stopTestServers
} from './helpers/harness.js';

/** CPFs de teste com dígito verificador válido. */
const CPF_A = '529.982.247-25';
const CPF_B = '111.444.777-35';

let panelUrl;
let ownerToken;
let adminToken;
let techToken;
let techId;
let adminId;
let ownerId;
const TECH = { username: 'tecnico', password: 'senha-teste-1111', email: 'tecnico@exemplo.test' };
const ADMIN = { username: 'gerente', password: 'senha-teste-2222', email: 'gerente@exemplo.test' };

const profile = (id, token, body) => call(`${panelUrl}/api/users/${id}/profile`, {
  method: 'PATCH', headers: authHeaders(token), body
});
const readProfile = (id, token) => call(`${panelUrl}/api/users/${id}/profile`, { headers: authHeaders(token) });

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'dono', password: 'senha-teste-3333', email: 'dono@exemplo.test' }
  });
  ownerToken = setup.body.data.token;
  ownerId = setup.body.data.user.id;

  const created = {};
  for (const [key, data, role] of [['tech', TECH, 'tech'], ['admin', ADMIN, 'admin']]) {
    const res = await call(`${panelUrl}/api/users`, {
      method: 'POST', headers: authHeaders(ownerToken), body: { ...data, role }
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    created[key] = res.body.data.user.id;
  }
  techId = created.tech;
  adminId = created.admin;
  techToken = (await call(`${panelUrl}/api/auth/login`, { method: 'POST', body: TECH })).body.data.token;
  adminToken = (await call(`${panelUrl}/api/auth/login`, { method: 'POST', body: ADMIN })).body.data.token;
});

after(async () => {
  await stopTestServers();
});

describe('operator profile', () => {
  it('saves and reads back a full record, formatting only on the way out', async () => {
    const res = await profile(techId, ownerToken, {
      fullName: 'João da Silva', cpf: CPF_A, phone: '(11) 91234-5678', zip: '01310-100',
      street: 'Av. Paulista', number: '1000', city: 'São Paulo', state: 'sp',
      jobTitle: 'Técnico de campo', birthDate: '1990-05-17', personalEmail: 'JOAO@Casa.test'
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const p = (await readProfile(techId, ownerToken)).body.data.profile;
    assert.equal(p.fullName, 'João da Silva');
    assert.equal(p.cpf, '52998224725');
    assert.equal(p.phone, '11912345678');
    assert.equal(p.zip, '01310100');
    assert.equal(p.state, 'SP');
    assert.equal(p.personalEmail, 'joao@casa.test');
  });

  it('never stores the CPF in the clear', async () => {
    const row = await getDb()('operator_profiles').where({ user_id: techId }).first();
    assert.ok(row.cpf_ciphertext && row.cpf_hash);
    assert.equal(row.cpf_last4, '4725');
    for (const [column, value] of Object.entries(row)) {
      assert.ok(!String(value ?? '').includes('52998224725'), `${column} holds the CPF in the clear`);
    }
  });

  it('shows a masked CPF in the list and never the full number', async () => {
    const { body } = await call(`${panelUrl}/api/users`, { headers: authHeaders(ownerToken) });
    const tech = body.data.users.find((u) => u.id === techId);
    assert.equal(tech.profile.fullName, 'João da Silva');
    assert.equal(tech.profile.cpfMasked, '***.***.*47-25');
    assert.ok(!JSON.stringify(body.data.users).includes('52998224725'));
  });

  it('rejects an invalid CPF, ZIP, state, phone and date', async () => {
    for (const bad of [
      { cpf: '111.111.111-11' }, { cpf: '123.456.789-00' }, { zip: '123' },
      { state: 'XX' }, { phone: '123' }, { birthDate: '2999-01-01' }, { birthDate: '1990-02-31' }
    ]) {
      const res = await profile(techId, ownerToken, bad);
      assert.equal(res.status, 400, JSON.stringify(bad));
    }
  });

  it('refuses a CPF already used by another team member, without saying who', async () => {
    assert.equal((await profile(adminId, ownerToken, { cpf: CPF_B })).status, 200);
    const res = await profile(techId, ownerToken, { cpf: CPF_B });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'cpf_in_use');
    assert.ok(!JSON.stringify(res.body).includes('gerente'));
  });

  it('clears a field and the CPF with null', async () => {
    assert.equal((await profile(adminId, ownerToken, { cpf: null, jobTitle: '' })).status, 200);
    const row = await getDb()('operator_profiles').where({ user_id: adminId }).first();
    assert.equal(row.cpf_ciphertext, null);
    assert.equal(row.cpf_hash, null);
    assert.equal(row.job_title, null);
  });

  it('lets a person edit their own record but not someone else’s without the permission', async () => {
    assert.equal((await profile(techId, techToken, { phone: '11988887777' })).status, 200);
    assert.equal((await profile(adminId, techToken, { phone: '11988887777' })).status, 403);
    assert.equal((await readProfile(adminId, techToken)).status, 403);
  });

  it('keeps an owner’s record away from an administrator, but not from the owner', async () => {
    assert.equal((await profile(ownerId, adminToken, { fullName: 'Intruso' })).status, 403);
    assert.equal((await readProfile(ownerId, adminToken)).status, 403);
    assert.equal((await profile(ownerId, ownerToken, { fullName: 'A Dona' })).status, 200);
  });

  it('answers 404 for someone who is not on this team', async () => {
    assert.equal((await profile(999999, ownerToken, { fullName: 'X' })).status, 404);
  });

  it('audits the field names and never the values', async () => {
    await profile(techId, ownerToken, { rg: '12.345.678-9', cpf: CPF_A });
    const rows = await getDb()('audit_log')
      .where({ tenant_id: await defaultTenantId(), action: 'operator.profile_updated' });
    assert.ok(rows.length >= 1);
    const text = JSON.stringify(rows);
    assert.ok(!text.includes('52998224725') && !text.includes('12.345.678-9'));
    assert.ok(rows.some((r) => String(r.detail).includes('fields')));
  });

  it('rejects an empty patch', async () => {
    assert.equal((await profile(techId, ownerToken, {})).status, 400);
  });
});

describe('editing a login from the team screen', () => {
  const edit = (id, token, body) => call(`${panelUrl}/api/users/${id}`, {
    method: 'PATCH', headers: authHeaders(token), body
  });

  it('changes username and email, and ends that person’s sessions', async () => {
    const before = Number((await getDb()('users').where({ id: techId }).first()).token_version || 0);
    const res = await edit(techId, ownerToken, { username: 'tecnico2', email: 'tecnico2@exemplo.test' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.user.username, 'tecnico2');
    assert.equal(res.body.data.loginChanged, true);
    const after = await getDb()('users').where({ id: techId }).first();
    assert.equal(Number(after.token_version || 0), before + 1);
    assert.equal(after.email, 'tecnico2@exemplo.test');
  });

  it('refuses a login that collides with another person, with the generic answer', async () => {
    const res = await edit(techId, ownerToken, { email: ADMIN.email });
    assert.equal(res.status, 409);
    assert.equal(res.body.message, (await edit(techId, ownerToken, { username: ADMIN.username })).body.message);
  });

  it('does not let a person change their own login this way, nor an admin touch the owner’s', async () => {
    assert.equal((await edit(ownerId, ownerToken, { email: 'novo@exemplo.test' })).status, 400);
    assert.equal((await edit(ownerId, adminToken, { email: 'novo@exemplo.test' })).status, 403);
  });
});

describe('profile lifecycle', () => {
  it('goes away with the membership', async () => {
    assert.ok(await getDb()('operator_profiles').where({ user_id: techId }).first());
    const res = await call(`${panelUrl}/api/users/${techId}`, { method: 'DELETE', headers: authHeaders(ownerToken) });
    assert.equal(res.status, 200);
    assert.equal(await getDb()('operator_profiles').where({ user_id: techId }).first(), undefined);
  });
});

/** Um PNG 1×1 de verdade, e um JPEG/WebP só com os primeiros bytes (o servidor confere o tipo, não decodifica). */
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const png = `data:image/png;base64,${PNG_1X1}`;
const avatar = (id, token, image) => call(`${panelUrl}/api/users/${id}/avatar`, {
  method: 'PUT', headers: authHeaders(token), body: { image }
});

describe('operator avatar', () => {
  it('saves a photo, returns it as a data URL and shows it in the list', async () => {
    const res = await avatar(adminId, ownerToken, png);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.profile.avatar, png);
    const { body } = await call(`${panelUrl}/api/users`, { headers: authHeaders(ownerToken) });
    assert.equal(body.data.users.find((u) => u.id === adminId).profile.avatar, png);
  });

  it('trusts the bytes and not the declared type', async () => {
    // Declarado JPEG, mas os bytes são PNG: vale o que os bytes provam.
    const res = await avatar(adminId, ownerToken, `data:image/jpeg;base64,${PNG_1X1}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.profile.avatar, png);
  });

  it('refuses SVG, other types and garbage', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
    for (const bad of [
      `data:image/svg+xml;base64,${svg}`,
      `data:image/png;base64,${svg}`,
      `data:text/html;base64,${svg}`,
      'not a data url', '', null, 123,
      'data:image/png;base64,!!!!'
    ]) {
      const res = await avatar(adminId, ownerToken, bad);
      assert.equal(res.status, 400, `${String(bad).slice(0, 40)} should be refused`);
      assert.equal(res.body.code, 'avatarInvalid');
    }
  });

  it('refuses a photo over the size cap with 413', async () => {
    const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100 * 1024)]);
    const res = await avatar(adminId, ownerToken, `data:image/png;base64,${big.toString('base64')}`);
    assert.equal(res.status, 413);
    assert.equal(res.body.code, 'avatarTooLarge');
  });

  it('follows the same permissions as the record', async () => {
    // O técnico do começo já foi apagado e teve o login trocado; um leitor novo
    // faz o papel de "pessoa sem permissão de administrar".
    const leitor = { username: 'leitor', password: 'senha-teste-4444', email: 'leitor@exemplo.test' };
    const created = await call(`${panelUrl}/api/users`, {
      method: 'POST', headers: authHeaders(ownerToken), body: { ...leitor, role: 'viewer' }
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const leitorId = created.body.data.user.id;
    const leitorToken = (await call(`${panelUrl}/api/auth/login`, { method: 'POST', body: leitor })).body.data.token;

    assert.equal((await avatar(leitorId, leitorToken, png)).status, 200);
    assert.equal((await avatar(adminId, leitorToken, png)).status, 403);
    assert.equal((await avatar(ownerId, adminToken, png)).status, 403);
    assert.equal((await avatar(999999, ownerToken, png)).status, 404);
  });

  it('removes the photo, and audits the field name only', async () => {
    const res = await call(`${panelUrl}/api/users/${adminId}/avatar`, { method: 'DELETE', headers: authHeaders(ownerToken) });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.profile.avatar, null);
    const row = await getDb()('operator_profiles').where({ user_id: adminId }).first();
    assert.equal(row.avatar_data, null);
    const rows = await getDb()('audit_log')
      .where({ tenant_id: await defaultTenantId(), action: 'operator.profile_updated' });
    assert.ok(!JSON.stringify(rows).includes(PNG_1X1));
  });
});

