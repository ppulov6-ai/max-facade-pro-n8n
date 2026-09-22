import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = JSON.parse(fs.readFileSync(
  new URL('../workflow/max-facade-pro.template.json', import.meta.url),
  'utf8'
));

const code = Object.fromEntries(
  workflow.nodes
    .filter((node) => node.type === 'n8n-nodes-base.code')
    .map((node) => [node.name, node.parameters.jsCode])
);

for (const [name, source] of Object.entries(code)) {
  assert.doesNotThrow(() => new Function('$input', '$items', source), `JavaScript: ${name}`);
}

let eventCalls = 0;
const normalize = (payload) => {
  eventCalls += 1;
  const run = new Function('$input', '$items', code['Нормализация события']);
  return run({ first: () => ({ json: payload }) }, () => []);
};

const runScenario = (event, prior = {}) => {
  const run = new Function('$input', '$items', code['Сценарий бота']);
  return run(
    { first: () => ({ json: prior }) },
    (name) => name === 'Нормализация события' ? [{ json: event }] : []
  );
};

const finalize = (source) => {
  const run = new Function('$input', '$items', code['Завершить заявку']);
  return run(
    { first: () => ({ json: source }) },
    (name) => name === 'Сценарий бота' ? [{ json: source }] : []
  )[0].json;
};

const botStarted = (user, id) => ({
  body: {
    update_type: 'bot_started',
    timestamp: id,
    chat_id: user,
    user: {
      user_id: user,
      first_name: 'Клиент',
      last_name: String(user),
      username: `client${user}`
    }
  }
});

const textMessage = (user, mid, text, attachments = []) => ({
  body: {
    update_type: 'message_created',
    timestamp: Number(String(user) + '01'),
    message: {
      sender: {
        user_id: user,
        first_name: 'Клиент',
        last_name: String(user),
        username: `client${user}`
      },
      recipient: { chat_id: user },
      body: { mid, text, attachments }
    }
  }
});

const callback = (user, callbackId, payload) => ({
  body: {
    update_type: 'message_callback',
    timestamp: Number(String(user) + '02'),
    callback: {
      callback_id: callbackId,
      payload,
      user: {
        user_id: user,
        first_name: 'Клиент',
        last_name: String(user),
        username: `client${user}`
      }
    },
    message: {
      sender: { user_id: 999999, first_name: 'Бот', is_bot: true },
      recipient: { chat_id: user },
      body: { mid: `bot-${callbackId}`, text: 'Кнопки' }
    }
  }
});

const contactAttachment = (user, phone, withHash = true) => ({
  type: 'contact',
  payload: {
    vcf_info: `BEGIN:VCARD\r\nVERSION:3.0\r\nTEL;TYPE=cell:${phone}\r\nFN:Клиент ${user}\r\nEND:VCARD\r\n`,
    max_info: { user_id: user, first_name: 'Клиент', last_name: String(user) },
    ...(withHash ? { hash: `hash-${user}` } : {})
  }
});

const one = (items) => {
  assert.equal(items.length, 1);
  return items[0].json;
};

function testNormalization() {
  let event = one(normalize(botStarted(11, 1001)));
  assert.equal(event.event_type, 'bot_started');
  assert.equal(event.user_id, '11');
  assert.equal(event.chat_id, '11');
  assert.equal(event.name, 'Клиент 11');

  event = one(normalize(textMessage(11, 'mid-text', 'Здравствуйте')));
  assert.equal(event.event_id, 'mid-text');
  assert.equal(event.text, 'Здравствуйте');

  event = one(normalize(callback(11, 'cb-service', 'service_kitchen')));
  assert.equal(event.user_id, '11');
  assert.equal(event.callback_payload, 'service_kitchen');
  assert.equal(event.event_id, 'cb-service');

  event = one(normalize(textMessage(11, 'mid-contact', '', [contactAttachment(11, '79991234567')])));
  assert.equal(event.phone, '+79991234567');
  assert.equal(event.contact_received, true);

  event = one(normalize(textMessage(11, 'mid-contact-bad', '', [contactAttachment(11, '79991234567', false)])));
  assert.equal(event.contact_received, false);

  assert.equal(normalize({ body: { update_type: 'message_created', timestamp: 1 } }).length, 0);
  assert.equal(normalize({ body: { update_type: 'bot_stopped', timestamp: 1 } }).length, 0);
}

function testCallbackBranch(count = 200) {
  for (let user = 1; user <= count; user += 1) {
    let state = one(runScenario(one(normalize(botStarted(user, 100000 + user)))));
    assert.equal(state.stage, 'await_service');

    state = one(runScenario(one(normalize(textMessage(user, `noise-${user}`, 'произвольный текст'))), state));
    assert.equal(state.stage, 'await_service');
    assert.equal(state.is_lead, false);

    const service = one(normalize(callback(user, `service-${user}`, 'service_kitchen')));
    state = one(runScenario(service, state));
    assert.equal(state.stage, 'await_connection_method');
    assert.equal(runScenario(service, state).length, 0);

    state = one(runScenario(one(normalize(callback(user, `method-${user}`, 'method_callback'))), state));
    assert.equal(state.stage, 'await_contact');

    state = one(runScenario(one(normalize(textMessage(
      user,
      `fake-${user}`,
      '',
      [contactAttachment(user, `7900${String(user).padStart(7, '0')}`, false)]
    ))), state));
    assert.equal(state.stage, 'await_contact');
    assert.equal(state.is_lead, false);

    const contactEvent = one(normalize(textMessage(
      user,
      `contact-${user}`,
      '',
      [contactAttachment(user, `7900${String(user).padStart(7, '0')}`)]
    )));
    state = one(runScenario(contactEvent, state));
    assert.equal(state.is_lead, true);
    assert.ok(state.manager_outgoing.text.includes(state.phone));
    assert.ok(state.client_outgoing.text.includes('Менеджер Наталья свяжется'));
    assert.equal(runScenario(contactEvent, state).length, 0);

    state = finalize(state);
    assert.equal(state.stage, 'completed');
    assert.equal(state.manager_notified, 'true');
  }
}

function testSelfContactBranch(start, count = 200) {
  for (let user = start; user < start + count; user += 1) {
    let state = one(runScenario(one(normalize(botStarted(user, 200000 + user)))));
    state = one(runScenario(one(normalize(callback(user, `service-${user}`, 'service_other'))), state));
    state = one(runScenario(one(normalize(textMessage(user, `noise-${user}`, 'позвоню сам'))), state));
    assert.equal(state.stage, 'await_connection_method');
    assert.equal(state.is_lead, false);

    const selfEvent = one(normalize(callback(user, `self-${user}`, 'method_self')));
    state = one(runScenario(selfEvent, state));
    assert.equal(state.is_lead, true);
    assert.equal(state.connection_method, 'Свяжется самостоятельно');
    assert.ok(state.client_outgoing.text.includes('REPLACE_WITH_MANAGER_PHONE'));
    assert.ok(state.manager_outgoing.text.includes('Телефон клиента не запрашивался'));
    assert.equal(runScenario(selfEvent, state).length, 0);

    state = finalize(state);
    const nextRequest = one(normalize(callback(user, `new-${user}`, 'new_request')));
    state = one(runScenario(nextRequest, state));
    assert.equal(state.stage, 'await_service');
    assert.equal(state.service, '');
    assert.equal(state.application_id, '');
  }
}

const started = Date.now();
for (let pass = 0; pass < 2; pass += 1) {
  testNormalization();
  testCallbackBranch(200);
  testSelfContactBranch(1001 + pass * 1000, 200);
}

console.log(JSON.stringify({
  ok: true,
  clean_passes: 2,
  user_journeys: 800,
  normalized_events: eventCalls,
  branches: ['ожидание звонка', 'самостоятельная связь'],
  elapsed_ms: Date.now() - started
}, null, 2));
