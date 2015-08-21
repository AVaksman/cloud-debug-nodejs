/**
 * Copyright 2015 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
 'use strict';

var assert = require('assert');

describe('uid', function() {
  var uid = require('../lib/uid.js');

  it('should return a GAE hash when GAE_MINOR_VERSION is set', function(done) {
    var test_gae_minor_version = '123456-test';
    process.env.GAE_MINOR_VERSION = test_gae_minor_version;
    uid.get('../', function(err, result) {
      assert.ifError(err);
      assert.strictEqual(result, 'GAE-' + test_gae_minor_version);
      done();
    });
  });

  it('should return a full file-contents based hash otherwise', function(done) {
    delete process.env.GAE_MINOR_VERSION;
    uid.get('./', function(err, result) {
      assert.ifError(err);
      assert.ok(result);
      assert.strictEqual(false, /^(GAE|GKE)-/.test(result));
      done();
    });
  });

  it('should error when invoked a directory without a package.json',
    function(done) {
      delete process.env.GAE_MINOR_VERSION;
      uid.get('./test/fixtures', function(err) {
        assert(err);
        done();
      });
    });
});
