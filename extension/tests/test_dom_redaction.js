/**
 * @fileoverview Comprehensive unit tests for Ticket 15 — DOM Text Substitution.
 * Tests pure function redactDomSkeleton for typed tokens, PII scrubbing,
 * pure function semantics, nested traversal, and envelope support.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  redactDomSkeleton,
  redactTextContent,
  redactUrlSlug,
  getRedactionToken,
  checkBBoxOverlap,
  normalizeBBox,
  REDACTION_TOKENS,
  DEFAULT_CATEGORY_TOKEN_MAP,
  DEFAULT_CATEGORY_PRIORITY
} from '../src/dom_redaction.js';

test('DOM Redaction: Exported tokens match specification', () => {
  assert.equal(REDACTION_TOKENS.PASSWORD, '[REDACTED_PASSWORD]');
  assert.equal(REDACTION_TOKENS.EMAIL, '[REDACTED_EMAIL]');
  assert.equal(REDACTION_TOKENS.CARD, '[REDACTED_CARD]');
  assert.equal(REDACTION_TOKENS.SSN, '[REDACTED_SSN]');
  assert.equal(REDACTION_TOKENS.PHONE, '[REDACTED_PHONE]');
  assert.equal(REDACTION_TOKENS.NAME, '[REDACTED_NAME]');
  assert.equal(REDACTION_TOKENS.PII, '[REDACTED_PII]');
});

test('DOM Redaction: Pure function semantics (cloning vs in-place mutation)', () => {
  const original = {
    tag: 'input',
    type: 'password',
    value: 'SuperSecret123!',
    placeholder: 'Enter your password',
    bbox: [100, 200, 200, 40]
  };

  // Pure function invocation (default)
  const result = redactDomSkeleton(original);

  // Original remains untouched
  assert.equal(original.value, 'SuperSecret123!');
  assert.equal(original.placeholder, 'Enter your password');

  // Result is redacted
  assert.equal(result.value, REDACTION_TOKENS.PASSWORD);
  assert.equal(result.placeholder, REDACTION_TOKENS.PASSWORD);

  // In-place mutation when option is specified
  const inPlaceTarget = {
    tag: 'input',
    type: 'password',
    value: 'AnotherSecret999!',
    bbox: [100, 200, 200, 40]
  };
  const mutated = redactDomSkeleton(inPlaceTarget, [], { inPlace: true });
  assert.equal(mutated, inPlaceTarget);
  assert.equal(inPlaceTarget.value, REDACTION_TOKENS.PASSWORD);
});

test('DOM Redaction: Password substitution for type=password and overlapping region', () => {
  const skeleton = {
    tag: 'form',
    children: [
      {
        tag: 'input',
        type: 'password',
        value: 'Passw0rd!',
        placeholder: 'Password',
        ariaLabel: 'Enter Password',
        bbox: [10, 20, 200, 30]
      },
      {
        tag: 'input',
        type: 'text',
        id: 'pwd-field',
        value: 'SecretPass123',
        bbox: [10, 60, 200, 30]
      }
    ]
  };

  const sensitiveRegions = [
    {
      bbox: [10, 60, 200, 30],
      category: 'password',
      source: 'dom',
      confidence: 1.0
    }
  ];

  const sanitized = redactDomSkeleton(skeleton, sensitiveRegions);

  // Intrinsic type=password node
  assert.equal(sanitized.children[0].value, REDACTION_TOKENS.PASSWORD);
  assert.equal(sanitized.children[0].placeholder, REDACTION_TOKENS.PASSWORD);
  assert.equal(sanitized.children[0].ariaLabel, REDACTION_TOKENS.PASSWORD);

  // Overlapping region node
  assert.equal(sanitized.children[1].value, REDACTION_TOKENS.PASSWORD);
});

test('DOM Redaction: Email substitution for overlapping region and inline free text', () => {
  const skeleton = {
    tag: 'div',
    children: [
      {
        tag: 'input',
        type: 'email',
        value: 'sensitive-user@domain.com',
        bbox: [50, 100, 250, 35]
      },
      {
        tag: 'p',
        text: 'For billing questions email alice.smith@example.org immediately.',
        bbox: [50, 150, 400, 20]
      }
    ]
  };

  const sensitiveRegions = [
    {
      bbox: [50, 100, 250, 35],
      category: 'email',
      source: 'ocr'
    }
  ];

  const sanitized = redactDomSkeleton(skeleton, sensitiveRegions);

  assert.equal(sanitized.children[0].value, REDACTION_TOKENS.EMAIL);
  assert.equal(
    sanitized.children[1].text,
    `For billing questions email ${REDACTION_TOKENS.EMAIL} immediately.`
  );
  assert.ok(!JSON.stringify(sanitized).includes('alice.smith@example.org'));
  assert.ok(!JSON.stringify(sanitized).includes('sensitive-user@domain.com'));
});

test('DOM Redaction: Credit card substitution for card regions, autocomplete, and text', () => {
  const skeleton = {
    tag: 'div',
    children: [
      {
        tag: 'input',
        autocomplete: 'cc-number',
        value: '4532 1234 5678 9012',
        bbox: [20, 20, 200, 30]
      },
      {
        tag: 'div',
        text: 'Your Visa ending in 4111-2222-3333-4444 has been charged.',
        bbox: [20, 60, 300, 25]
      },
      {
        tag: 'span',
        text: '9876543210987654',
        bbox: [20, 90, 150, 20]
      }
    ]
  };

  const sensitiveRegions = [
    {
      bbox: [20, 90, 150, 20],
      category: 'card',
      source: 'ocr'
    }
  ];

  const sanitized = redactDomSkeleton(skeleton, sensitiveRegions);

  assert.equal(sanitized.children[0].value, REDACTION_TOKENS.CARD);
  assert.equal(
    sanitized.children[1].text,
    `Your Visa ending in ${REDACTION_TOKENS.CARD} has been charged.`
  );
  assert.equal(sanitized.children[2].text, REDACTION_TOKENS.CARD);
  assert.ok(!JSON.stringify(sanitized).includes('4532 1234 5678 9012'));
  assert.ok(!JSON.stringify(sanitized).includes('4111-2222-3333-4444'));
  assert.ok(!JSON.stringify(sanitized).includes('9876543210987654'));
});

test('DOM Redaction: SSN substitution for ssn regions and pattern matches', () => {
  const skeleton = {
    tag: 'div',
    children: [
      {
        tag: 'input',
        name: 'ssn',
        value: '123-45-6789',
        bbox: [10, 10, 150, 30]
      },
      {
        tag: 'p',
        textContent: 'Social Security Number on file: 987-65-4321.',
        bbox: [10, 50, 300, 20]
      }
    ]
  };

  const sensitiveRegions = [
    {
      bbox: [10, 10, 150, 30],
      category: 'ssn'
    }
  ];

  const sanitized = redactDomSkeleton(skeleton, sensitiveRegions);

  assert.equal(sanitized.children[0].value, REDACTION_TOKENS.SSN);
  assert.equal(
    sanitized.children[1].textContent,
    `Social Security Number on file: ${REDACTION_TOKENS.SSN}.`
  );
  assert.ok(!JSON.stringify(sanitized).includes('123-45-6789'));
  assert.ok(!JSON.stringify(sanitized).includes('987-65-4321'));
});

test('DOM Redaction: Phone substitution for phone regions and pattern matches', () => {
  const skeleton = {
    tag: 'div',
    children: [
      {
        tag: 'input',
        type: 'tel',
        value: '+1 (555) 234-5678',
        bbox: [100, 100, 180, 30]
      },
      {
        tag: 'span',
        innerText: 'Call emergency at 800-555-0199 or 212-555-1212.',
        bbox: [100, 140, 280, 25]
      }
    ]
  };

  const sensitiveRegions = [
    {
      bbox: [100, 100, 180, 30],
      category: 'phone'
    }
  ];

  const sanitized = redactDomSkeleton(skeleton, sensitiveRegions);

  assert.equal(sanitized.children[0].value, REDACTION_TOKENS.PHONE);
  assert.ok(sanitized.children[1].innerText.includes(REDACTION_TOKENS.PHONE));
  assert.ok(!JSON.stringify(sanitized).includes('555) 234-5678'));
  assert.ok(!JSON.stringify(sanitized).includes('800-555-0199'));
  assert.ok(!JSON.stringify(sanitized).includes('212-555-1212'));
});

test('DOM Redaction: Name substitution for face/name regions and explicit text', () => {
  const skeleton = {
    tag: 'div',
    children: [
      {
        tag: 'div',
        text: 'Profile photo of Bob Marley',
        bbox: [300, 100, 80, 80]
      },
      {
        tag: 'span',
        text: 'Patient: Bob Marley, DOB: 01/01/1980',
        bbox: [300, 190, 250, 30]
      }
    ]
  };

  const sensitiveRegions = [
    {
      bbox: [300, 100, 80, 80],
      category: 'face',
      source: 'cv'
    },
    {
      category: 'name',
      text: 'Bob Marley'
    }
  ];

  const sanitized = redactDomSkeleton(skeleton, sensitiveRegions);

  // Overlapping face/name box replaced with [REDACTED_NAME]
  assert.equal(sanitized.children[0].text, REDACTION_TOKENS.NAME);

  // Explicit text 'Bob Marley' in span replaced with [REDACTED_NAME]
  assert.equal(
    sanitized.children[1].text,
    `Patient: ${REDACTION_TOKENS.NAME}, DOB: 01/01/1980`
  );
  assert.ok(!JSON.stringify(sanitized).includes('Bob Marley'));
});

test('DOM Redaction: Generic PII substitution for unmapped or pii categories', () => {
  const skeleton = {
    tag: 'div',
    text: 'Internal confidential employee evaluation token',
    bbox: [50, 50, 200, 40]
  };

  const sensitiveRegions = [
    {
      bbox: [50, 50, 200, 40],
      category: 'pii',
      source: 'cv'
    }
  ];

  const sanitized = redactDomSkeleton(skeleton, sensitiveRegions);
  assert.equal(sanitized.text, REDACTION_TOKENS.PII);
});

test('DOM Redaction: All sensitive content fields are redacted', () => {
  const node = {
    tag: 'input',
    type: 'text',
    value: 'secretVal',
    text: 'secretText',
    textContent: 'secretContent',
    innerText: 'secretInner',
    placeholder: 'secretPlaceholder',
    ariaLabel: 'secretAria',
    'aria-label': 'secretAriaDash',
    aria_label: 'secretAriaUnderscore',
    title: 'secretTitle',
    alt: 'secretAlt',
    label: 'secretLabel',
    labelText: 'secretLabelText',
    bbox: [10, 10, 100, 30]
  };

  const sanitized = redactDomSkeleton(node, [
    { bbox: [10, 10, 100, 30], category: 'password' }
  ]);

  assert.equal(sanitized.value, REDACTION_TOKENS.PASSWORD);
  assert.equal(sanitized.text, REDACTION_TOKENS.PASSWORD);
  assert.equal(sanitized.textContent, REDACTION_TOKENS.PASSWORD);
  assert.equal(sanitized.innerText, REDACTION_TOKENS.PASSWORD);
  assert.equal(sanitized.placeholder, REDACTION_TOKENS.PASSWORD);
  assert.equal(sanitized.ariaLabel, REDACTION_TOKENS.PASSWORD);
  assert.equal(sanitized['aria-label'], REDACTION_TOKENS.PASSWORD);
  assert.equal(sanitized.aria_label, REDACTION_TOKENS.PASSWORD);
  assert.equal(sanitized.title, REDACTION_TOKENS.PASSWORD);
  assert.equal(sanitized.alt, REDACTION_TOKENS.PASSWORD);
  assert.equal(sanitized.label, REDACTION_TOKENS.PASSWORD);
  assert.equal(sanitized.labelText, REDACTION_TOKENS.PASSWORD);
});

test('DOM Redaction: Preserves non-sensitive structure, tags, and selectors', () => {
  const skeleton = {
    tag: 'button',
    id: 'submit-btn',
    name: 'submitAction',
    selector: '#submit-btn',
    xpath: '/html/body/button',
    role: 'button',
    interactive: true,
    bbox: [100, 200, 80, 30],
    text: 'Submit'
  };

  const sanitized = redactDomSkeleton(skeleton, []);

  assert.equal(sanitized.tag, 'button');
  assert.equal(sanitized.id, 'submit-btn');
  assert.equal(sanitized.name, 'submitAction');
  assert.equal(sanitized.selector, '#submit-btn');
  assert.equal(sanitized.xpath, '/html/body/button');
  assert.equal(sanitized.role, 'button');
  assert.equal(sanitized.interactive, true);
  assert.deepEqual(sanitized.bbox, [100, 200, 80, 30]);
  assert.equal(sanitized.text, 'Submit');
});

test('DOM Redaction: Deeply nested hierarchy traversal', () => {
  const deepTree = {
    tag: 'body',
    children: [
      {
        tag: 'div',
        children: [
          {
            tag: 'section',
            children: [
              {
                tag: 'p',
                text: 'User email is secret.agent@mi6.gov.uk',
                children: [
                  {
                    tag: 'span',
                    text: 'Call +1-800-555-9999 for backup'
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  };

  const sanitized = redactDomSkeleton(deepTree);

  const span = sanitized.children[0].children[0].children[0].children[0];
  const p = sanitized.children[0].children[0].children[0];

  assert.equal(p.text, `User email is ${REDACTION_TOKENS.EMAIL}`);
  assert.equal(span.text, `Call ${REDACTION_TOKENS.PHONE} for backup`);
  assert.ok(!JSON.stringify(sanitized).includes('mi6.gov.uk'));
  assert.ok(!JSON.stringify(sanitized).includes('800-555-9999'));
});

test('DOM Redaction: Handles envelope formats ({ skeleton }, { tree }, { elements })', () => {
  const envelope = {
    success: true,
    viewport: { width: 1920, height: 1080 },
    skeleton: {
      tag: 'input',
      type: 'password',
      value: 'secretEnvPass'
    },
    elements: [
      {
        tag: 'span',
        text: 'Contact: alert@bank.com'
      }
    ]
  };

  const sanitized = redactDomSkeleton(envelope);

  assert.equal(sanitized.success, true);
  assert.deepEqual(sanitized.viewport, { width: 1920, height: 1080 });
  assert.equal(sanitized.skeleton.value, REDACTION_TOKENS.PASSWORD);
  assert.equal(sanitized.elements[0].text, `Contact: ${REDACTION_TOKENS.EMAIL}`);
});

test('DOM Redaction: Resolves overlapping categories using priority (password > email)', () => {
  const node = {
    tag: 'input',
    id: 'conflicted-field',
    value: 'secretPasswordVal',
    bbox: [100, 100, 200, 40]
  };

  const overlappingRegions = [
    {
      bbox: [100, 100, 200, 40],
      category: 'email',
      confidence: 0.99
    },
    {
      bbox: [100, 100, 200, 40],
      category: 'password',
      confidence: 0.8
    }
  ];

  const sanitized = redactDomSkeleton(node, overlappingRegions);
  // Password has higher priority than email
  assert.equal(sanitized.value, REDACTION_TOKENS.PASSWORD);
});

test('DOM Redaction: Selector and ID matching without bbox', () => {
  const skeleton = {
    tag: 'div',
    children: [
      {
        tag: 'input',
        id: 'account-secret',
        selector: '#account-secret',
        value: 'HiddenData123'
      },
      {
        tag: 'input',
        id: 'other-id',
        value: 'OtherSecret456'
      }
    ]
  };

  const regions = [
    {
      selector: '#account-secret',
      category: 'password'
    },
    {
      id: 'other-id',
      category: 'ssn'
    }
  ];

  const sanitized = redactDomSkeleton(skeleton, regions);

  assert.equal(sanitized.children[0].value, REDACTION_TOKENS.PASSWORD);
  assert.equal(sanitized.children[1].value, REDACTION_TOKENS.SSN);
});

test('DOM Redaction: Edge cases (null, empty, already redacted)', () => {
  assert.equal(redactDomSkeleton(null), null);
  assert.equal(redactDomSkeleton(undefined), undefined);
  assert.deepEqual(redactDomSkeleton([]), []);
  assert.deepEqual(redactDomSkeleton({}), {});

  // Idempotency: already redacted skeleton remains unchanged
  const alreadyRedacted = {
    tag: 'input',
    type: 'password',
    value: REDACTION_TOKENS.PASSWORD,
    placeholder: REDACTION_TOKENS.PASSWORD
  };
  const reRedacted = redactDomSkeleton(alreadyRedacted);
  assert.equal(reRedacted.value, REDACTION_TOKENS.PASSWORD);
  assert.equal(reRedacted.placeholder, REDACTION_TOKENS.PASSWORD);
});

test('DOM Redaction: Custom token map option', () => {
  const skeleton = {
    tag: 'input',
    type: 'password',
    value: 'secretVal'
  };

  const sanitized = redactDomSkeleton(skeleton, [], {
    tokenMap: {
      password: '[CUSTOM_PW]'
    }
  });

  assert.equal(sanitized.value, '[CUSTOM_PW]');
});

test('DOM Redaction: URL slug-only sanitization preserves URL hierarchy and query parameters', () => {
  assert.equal(
    redactUrlSlug('https://example.com/in/daksh-shah'),
    'https://example.com/in/[REDACTED_NAME]'
  );
  assert.equal(
    redactUrlSlug('https://example.com/in/daksh-shah/details'),
    'https://example.com/in/[REDACTED_NAME]/details'
  );
  assert.equal(
    redactUrlSlug('https://example.com/profile?user=daksh'),
    'https://example.com/profile?user=[REDACTED_NAME]'
  );
  assert.equal(
    redactUrlSlug('https://example.org/~daksh/cv.pdf'),
    'https://example.org/~[REDACTED_NAME]/cv.pdf'
  );
  assert.equal(
    redactUrlSlug('https://linkedin.com/in/daksh-shah?trk=profile', ['Daksh Shah']),
    'https://linkedin.com/in/[REDACTED_NAME]?trk=profile'
  );
  assert.equal(
    redactUrlSlug('https://company.org/members/daksh_shah/profile', ['Daksh Shah']),
    'https://company.org/members/[REDACTED_NAME]/profile'
  );
});

test('DOM Redaction: Full text name substitution preserves surrounding copy', () => {
  const text = 'Profile viewed by Daksh Shah and 15 others recently.';
  const redacted = redactTextContent(text, { names: ['Daksh Shah'] });
  assert.equal(redacted, `Profile viewed by ${REDACTION_TOKENS.NAME} and 15 others recently.`);
});

test('DOM Redaction: Sanitizes node href and src attributes', () => {
  const tree = {
    tag: 'div',
    children: [
      {
        tag: 'a',
        href: 'https://linkedin.com/in/daksh-shah',
        text: 'View Daksh Shah Profile',
        selector: '#link-profile'
      },
      {
        tag: 'img',
        src: 'https://media.licdn.com/dms/image/users/daksh-shah/avatar.jpg',
        selector: '#avatar-img'
      }
    ]
  };

  const sanitized = redactDomSkeleton(tree, [], { names: ['Daksh Shah'] });
  assert.equal(sanitized.children[0].href, 'https://linkedin.com/in/[REDACTED_NAME]');
  assert.equal(sanitized.children[0].text, `View ${REDACTION_TOKENS.NAME} Profile`);
  assert.equal(sanitized.children[1].src, 'https://media.licdn.com/dms/image/users/[REDACTED_NAME]/avatar.jpg');
});
