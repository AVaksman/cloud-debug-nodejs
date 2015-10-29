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

process.env.GCLOUD_DEBUG_DISABLE = 1;

var assert = require('assert');

describe('should respect environment variables', function() {
  it('should respect GCLOUD_DEBUG_DISABLE', function() {
    var agent = require('../..');
    assert(!agent.debug, 'Agent should not have started');
  });

});
