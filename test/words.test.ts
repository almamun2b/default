import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameFromDomain, nameFromLabel, splitWords } from '../src/words.js';

test('a domain becomes words: known words are split, short consonant runs are capitals, the rest is one word', () => {
  assert.equal(nameFromDomain('anytimefitness.in'), 'Anytime Fitness');
  assert.equal(nameFromDomain('smashtennis.co.nz'), 'Smash Tennis');
  assert.equal(nameFromDomain('greatoceanroadresort.com.au'), 'Great Ocean Road Resort');
  assert.equal(nameFromDomain('autohaus-pickel.de'), 'Autohaus Pickel');
  assert.equal(nameFromDomain('clmnz.co.nz'), 'CLMNZ');
  assert.equal(nameFromDomain('ktmg.com.au'), 'KTMG');
  assert.equal(nameFromDomain('kryalcastle.com.au'), 'Kryalcastle'); // not made of known words
  assert.equal(nameFromDomain('bega.com.au'), 'Bega'); // a place, not capitals
});

test('splitWords gives up instead of cutting an unknown word into fragments', () => {
  assert.equal(splitWords('xqzvbn'), null);
  assert.deepEqual(splitWords('socialsquad'), ['social', 'squad']);
  assert.equal(nameFromLabel('customerservice'), 'Customer Service');
  assert.equal(nameFromLabel('customer.service'), 'Customer Service');
});

test('digits: one or two stay on the letters before them, a longer number is its own word', () => {
  assert.equal(nameFromDomain('q1.com.au'), 'Q1');
  assert.equal(nameFromDomain('t4arb.com'), 'T4 Arb');
  assert.equal(nameFromDomain('ericadams2021.com'), 'Eric Adams 2021');
});
