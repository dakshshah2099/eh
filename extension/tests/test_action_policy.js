import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyActionRisk,
  enforceConfirmationGate,
  ConfirmationRequired,
  ConfirmationDeclined,
  RISK_TIERS,
  HIGH_RISK_PATTERNS
} from '../src/action_policy.js';
import {
  executeAction,
  executeActions,
  executeClick
} from '../src/action_executor.js';

test('Ticket 07 / C7: classifyActionRisk correctly classifies low-risk actions and sets action fields', () => {
  // scroll action
  const scrollAction = { type: 'scroll', deltaY: 200 };
  const scrollRes = classifyActionRisk(scrollAction);
  assert.equal(scrollRes.risk, 'low');
  assert.equal(scrollRes.requires_confirmation, false);
  assert.equal(scrollAction.risk, 'low');
  assert.equal(scrollAction.requires_confirmation, false);

  // wait action
  const waitAction = { type: 'wait', delay_ms: 500 };
  const waitRes = classifyActionRisk(waitAction);
  assert.equal(waitRes.risk, 'low');
  assert.equal(waitRes.requires_confirmation, false);
  assert.equal(waitAction.risk, 'low');
  assert.equal(waitAction.requires_confirmation, false);

  // read action
  const readAction = { type: 'read', target_selector: '#article' };
  const readRes = classifyActionRisk(readAction);
  assert.equal(readRes.risk, 'low');
  assert.equal(readRes.requires_confirmation, false);
  assert.equal(readAction.risk, 'low');

  // scroll action in the context of a high-risk task still passes through as low risk
  const scrollInBuyTask = { type: 'scroll', deltaY: 100 };
  const scrollContextRes = classifyActionRisk(scrollInBuyTask, { task: 'Buy shoes on Amazon and pay for order' });
  assert.equal(scrollContextRes.risk, 'low');
  assert.equal(scrollContextRes.requires_confirmation, false);
  assert.equal(scrollInBuyTask.risk, 'low');
  assert.equal(scrollInBuyTask.requires_confirmation, false);
});

test('Ticket 07 / C7: classifyActionRisk correctly classifies medium-risk actions', () => {
  // type action (benign)
  const typeAction = { type: 'type', target_selector: '#search-box', text: 'mechanical keyboard' };
  const typeRes = classifyActionRisk(typeAction);
  assert.equal(typeRes.risk, 'medium');
  assert.equal(typeRes.requires_confirmation, false);
  assert.equal(typeAction.risk, 'medium');
  assert.equal(typeAction.requires_confirmation, false);

  // navigate action (benign)
  const navAction = { type: 'navigate', url: 'https://example.com/products' };
  const navRes = classifyActionRisk(navAction);
  assert.equal(navRes.risk, 'medium');
  assert.equal(navRes.requires_confirmation, false);
  assert.equal(navAction.risk, 'medium');

  // click action (benign)
  const clickAction = { type: 'click', target_selector: '#next-page-btn' };
  const clickRes = classifyActionRisk(clickAction);
  assert.equal(clickRes.risk, 'medium');
  assert.equal(clickRes.requires_confirmation, false);
  assert.equal(clickAction.risk, 'medium');
});

test('Ticket 07 / C7: classifyActionRisk classifies high-risk actions across payment, purchase, delete, send, and password', () => {
  // 1. Payment / Purchase via target_selector
  const paySelectorAction = { type: 'click', target_selector: '#submit-payment' };
  const res1 = classifyActionRisk(paySelectorAction);
  assert.equal(res1.risk, 'high');
  assert.equal(res1.requires_confirmation, true);
  assert.equal(paySelectorAction.risk, 'high');
  assert.equal(paySelectorAction.requires_confirmation, true);

  // 2. Payment / Purchase via reason field
  const payReasonAction = { type: 'click', target_selector: '#primary-btn', reason: 'Submit Payment for checkout' };
  const res2 = classifyActionRisk(payReasonAction);
  assert.equal(res2.risk, 'high');
  assert.equal(res2.requires_confirmation, true);

  // 3. Purchase via button text
  const buyTextAction = { type: 'click', target_selector: '#order-btn', text: 'Place Order' };
  const res3 = classifyActionRisk(buyTextAction);
  assert.equal(res3.risk, 'high');
  assert.equal(res3.requires_confirmation, true);

  // 4. Delete action via selector
  const deleteAction = { type: 'click', target_selector: '#delete-account-button' };
  const res4 = classifyActionRisk(deleteAction);
  assert.equal(res4.risk, 'high');
  assert.equal(res4.requires_confirmation, true);

  // 5. Send message action via reason and selector
  const sendAction = { type: 'click', target_selector: '#send-btn', reason: 'Send message to recipient' };
  const res5 = classifyActionRisk(sendAction);
  assert.equal(res5.risk, 'high');
  assert.equal(res5.requires_confirmation, true);

  // 6. Change password action
  const pwdAction = { type: 'click', target_selector: '#change-password-submit' };
  const res6 = classifyActionRisk(pwdAction);
  assert.equal(res6.risk, 'high');
  assert.equal(res6.requires_confirmation, true);

  // 7. Context task string triggering high risk on active mutation action
  const taskAction = { type: 'click', target_selector: '#confirm' };
  const res7 = classifyActionRisk(taskAction, { task: 'Submit payment for cart items' });
  assert.equal(res7.risk, 'high');
  assert.equal(res7.requires_confirmation, true);
});

test('Ticket 07 / C7: classifyActionRisk reads ui_elements for element semantics (Ticket 01 / C1)', () => {
  const uiElements = [
    { id: 'el-42', label: 'Submit Payment', category: 'button', bbox: [100, 200, 80, 40] },
    { id: 'el-99', label: 'Search Results', category: 'container', bbox: [0, 0, 500, 300] }
  ];

  // Action targets el-42 by element_id
  const action1 = { type: 'click', target_element_id: 'el-42' };
  const res1 = classifyActionRisk(action1, { ui_elements: uiElements });
  assert.equal(res1.risk, 'high');
  assert.equal(res1.requires_confirmation, true);
  assert.equal(action1.risk, 'high');

  // Action targets el-99 (benign)
  const action2 = { type: 'click', target_element_id: 'el-99' };
  const res2 = classifyActionRisk(action2, { ui_elements: uiElements });
  assert.equal(res2.risk, 'medium');
  assert.equal(res2.requires_confirmation, false);
});

test('Ticket 07 / C7: enforceConfirmationGate permits low/medium actions and blocks high-risk without confirmation', async () => {
  // Low-risk passes through without any callback
  const scrollAction = { type: 'scroll', deltaY: 100 };
  const passLow = await enforceConfirmationGate(scrollAction);
  assert.equal(passLow, true);

  // Medium-risk passes through without any callback
  const typeAction = { type: 'type', target_selector: '#q', text: 'laptop' };
  const passMed = await enforceConfirmationGate(typeAction);
  assert.equal(passMed, true);

  // High-risk ("Submit Payment") without confirmation callback throws ConfirmationRequired
  const highRiskAction = {
    type: 'click',
    target_selector: '#btn-pay',
    reason: 'Submit Payment'
  };

  await assert.rejects(
    async () => {
      await enforceConfirmationGate(highRiskAction);
    },
    (err) => {
      assert.ok(err instanceof ConfirmationRequired, 'Error must be instance of ConfirmationRequired');
      assert.equal(err.name, 'ConfirmationRequired');
      assert.equal(err.requires_confirmation, true);
      assert.ok(err.message.includes('ConfirmationRequired'));
      return true;
    }
  );
});

test('Ticket 07 / C7: enforceConfirmationGate handles confirmation callback approval and declination', async () => {
  const highRiskAction1 = {
    type: 'click',
    target_selector: '#submit-payment',
    reason: 'Submit Payment'
  };

  let callbackReceivedAction = null;
  const onConfirmApproved = async (action) => {
    callbackReceivedAction = action;
    return true;
  };

  // Approved: passes through and marks action.confirmed = true
  const passApproved = await enforceConfirmationGate(highRiskAction1, { onConfirmAction: onConfirmApproved });
  assert.equal(passApproved, true);
  assert.equal(highRiskAction1.confirmed, true);
  assert.equal(callbackReceivedAction.target_selector, '#submit-payment');

  // Declined: throws ConfirmationDeclined (and is instance of ConfirmationRequired)
  const highRiskAction2 = {
    type: 'click',
    target_selector: '#delete-account-btn',
    reason: 'Delete account'
  };

  const onConfirmDeclined = async () => false;

  await assert.rejects(
    async () => {
      await enforceConfirmationGate(highRiskAction2, { onConfirmAction: onConfirmDeclined });
    },
    (err) => {
      assert.ok(err instanceof ConfirmationRequired, 'Must inherit from ConfirmationRequired');
      assert.ok(err instanceof ConfirmationDeclined, 'Must be instance of ConfirmationDeclined');
      assert.equal(err.name, 'ConfirmationDeclined');
      return true;
    }
  );
});

test('Ticket 07 / C7: executeAction blocks "Submit Payment" click action pending confirmation, allows scroll', async () => {
  // Mock element and DOM
  const payBtn = {
    nodeType: 1,
    tagName: 'BUTTON',
    id: 'pay-btn',
    innerText: 'Submit Payment',
    textContent: 'Submit Payment',
    getAttribute: (attr) => (attr === 'id' ? 'pay-btn' : null),
    getBoundingClientRect: () => ({ left: 10, top: 10, width: 100, height: 40 }),
    dispatchEvent: () => true,
    focus: () => {}
  };

  const origDoc = globalThis.document;
  globalThis.document = {
    querySelector: (sel) => (sel === '#pay-btn' ? payBtn : null),
    getElementById: (id) => (id === 'pay-btn' ? payBtn : null),
    elementFromPoint: () => payBtn
  };

  try {
    // 1. Scroll action passes through without confirmation
    const scrollRes = await executeAction({ type: 'scroll', deltaY: 50 });
    assert.equal(scrollRes.success, true);
    assert.equal(scrollRes.action, 'scroll');

    // 2. "Submit Payment" click action without confirmation throws ConfirmationRequired before execution
    const submitPaymentAction = {
      type: 'click',
      target_selector: '#pay-btn',
      reason: 'Submit Payment'
    };

    await assert.rejects(
      async () => {
        await executeAction(submitPaymentAction);
      },
      (err) => {
        assert.ok(err instanceof ConfirmationRequired);
        assert.equal(err.name, 'ConfirmationRequired');
        return true;
      }
    );

    // Verify fields were added to the action object
    assert.equal(submitPaymentAction.risk, 'high');
    assert.equal(submitPaymentAction.requires_confirmation, true);

    // 3. "Submit Payment" click action with approval callback executes successfully
    let confirmedLogged = false;
    const approvedRes = await executeAction(submitPaymentAction, {
      onConfirmAction: async (act) => {
        confirmedLogged = true;
        assert.equal(act.risk, 'high');
        assert.equal(act.requires_confirmation, true);
        return true;
      }
    });

    assert.equal(confirmedLogged, true);
    assert.equal(approvedRes.success, true);
    assert.equal(approvedRes.action, 'click');

    // 4. "Submit Payment" click action with declining callback throws ConfirmationDeclined
    const declineAction = {
      type: 'click',
      target_selector: '#pay-btn',
      reason: 'Submit Payment'
    };

    await assert.rejects(
      async () => {
        await executeAction(declineAction, {
          onConfirmAction: async () => false
        });
      },
      (err) => {
        assert.ok(err instanceof ConfirmationRequired);
        assert.equal(err.name, 'ConfirmationDeclined');
        return true;
      }
    );
  } finally {
    globalThis.document = origDoc;
  }
});

test('Ticket 07 / C7: executeActions batch halts when unconfirmed high-risk action encountered', async () => {
  const actions = [
    { type: 'scroll', deltaY: 100 },
    { type: 'click', target_selector: '#submit-payment', reason: 'Submit Payment' },
    { type: 'scroll', deltaY: 50 }
  ];

  await assert.rejects(
    async () => {
      await executeActions(actions);
    },
    (err) => {
      assert.ok(err instanceof ConfirmationRequired);
      return true;
    }
  );

  // First action (scroll) got classified as low
  assert.equal(actions[0].risk, 'low');
  // Second action (submit payment) got classified as high
  assert.equal(actions[1].risk, 'high');
  assert.equal(actions[1].requires_confirmation, true);
});
