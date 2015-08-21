/**
 * Copyright 2014 Google Inc. All Rights Reserved.
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

var v8debug = require('./v8debugapi.js');
var DebugletApi = require('./debugletapi.js');
var uid = require('./uid.js');
var Logger = require('../logger.js');

var assert = require('assert');

var NODE_VERSION_MESSAGE = 'V8 Debug API not available – make sure you are ' +
    'running Node.js >=0.12 or io.js >= 1.0';

// TODO: formalize this module.exports into an Agent class.
module.exports = {
  start: function(config, logger, exports) {
    var agent = new Debuglet(config, logger);
    agent.start(function(err) {
      // For e2e testing.
      if (!err) {
        exports.debug.api_ = agent.debugletApi_;
      }
    });

    exports.debug = {/* nothing yet */};
  }
};

/**
 * @param {Object} config The option parameters for the Debuglet.
 * @constructor
 */
function Debuglet(config, logger) {
  /** @private {Object} */
  this.config_ = config || {};

  /** @private {boolean} */
  this.running_ = false;

  /** @private {boolean} */
  this.fetcherActive_ = false;

  /** @private {Logger} */
  this.logger_ = logger;

  /** @private {DebugletApi} */
  this.debugletApi_ = new DebugletApi();

  /** @private {Object.<string, Breakpoint>} */
  this.activeBreakpointMap_ = {};

  /** @private {Object.<string, Breakpoint>} */
  this.completedBreakpointMap_ = {};
}

/**
 * Starts the Debuglet. It is important that this is as quick as possible
 * as it is on the critical path of application startup.
 * @param {function(?Error)=} opt_callback
 * @private
 */
Debuglet.prototype.start = function(opt_callback) {
  var that = this;

  uid.get(that.config_.workingDirectory, function(err, uid) {
    if (err) {
      that.logger_.error('Unable to compute unique id of the application', err);
      if (opt_callback) {
        opt_callback(err);
      }
      return;
    }
    that.logger_.info('Unique ID for this Application: ' + uid);

    that.debugletApi_.init(uid, function(err) {
      if (err) {
        that.logger_.error('Unable to initialize the debuglet api' +
          ' -- disabling debuglet', err);
        if (opt_callback) {
          opt_callback(err);
        }
        return;
      }

      // Initialize the V8 Debug API now
      if (!v8debug.init(that.logger_, that.config_)) {
        that.logger_.error(NODE_VERSION_MESSAGE);
        // Report the version problem to the API ignoring any problems
        // encountered during registration.
        that.debugletApi_.registerError(NODE_VERSION_MESSAGE, function() {});
        if (opt_callback) {
          opt_callback(new Error(NODE_VERSION_MESSAGE));
        }
        return;
      }

      // We can register as a debuggee now.
      that.running_ = true;
      that.scheduleRegistration_(0);

      if (opt_callback) {
        opt_callback(null);
      }
    });
  });
};

/**
 * Register to the Cloud Debug API
 * @param {function(?Error)} callback
 * @private
 */
Debuglet.prototype.registerAsDebuggee_ = function(callback) {
  if (!this.running_) {
    callback(new Error('Debuglet not running'));
    return;
  }

  var that = this;

  that.debugletApi_.register(function(err, result) {
    if (err) {
      callback(err);
      return;
    }

    if (result.debuggee.isDisabled) {
      // Server has disabled this debuggee / debug agent.
      callback(new Error('Disabled by the server'));
      return;
    }

    var expiry = result.activePeriodSec;
    that.logger_.info('Registered as debuggee: ' + result.debuggee.id +
      ' active period: ' + expiry + 'sec');

    if (expiry) {
      // V2 API no longer replies with activePeriodSec. The listBreakpoints
      // endpoint instead triggers expiry with a 404.
      // TODO(ofrobots): once V2 becomes the default, get rid of this code
      // completely.
      that.scheduleRegistration_(expiry);
    }

    if (!that.fetcherActive_) {
      that.scheduleBreakpointFetch_(0);
    }

    callback(null);
  });
};

/**
 * Fetch the list of breakpoints from the server. Updates the internal state
 * of active breakpoints to match the server. This runs periodically for the
 * duration of our registration.
 * @private
 */
Debuglet.prototype.fetchBreakpoints_ = function() {
  var that = this;

  if (!that.running_) {
    return;
  }
  assert(that.fetcherActive_);

  that.logger_.info('Fetching breakpoints');
  that.debugletApi_.listBreakpoints(function(err, response, body) {
    if (err) {
      that.logger_.error('Unable to fetch breakpoints – stopping fetcher',
        err);
      that.fetcherActive_ = false;
      // This backs-off the fetcher to the next registration. If the network
      // issues have been resolved by then, the fetcher will get activated
      // again.
      // TODO(ofrobots): once we remove scheduleRegistration, we will have
      // to insert a manual call to register here
      return;
    }

    switch (response.statusCode) {
      case 404:
        // Registration expired. Deactivate the fetcher and queue
        // re-registration, which will re-active breakpoint fetching.
        that.logger_.info('\tRegistration expired.');
        that.fetcherActive_ = false;
        that.scheduleRegistration_(0 /*immediately*/);
        return;

      case 409: // Timeout on a hanging GET.
        that.logger_.info('\tdetected no changes');
        that.scheduleBreakpointFetch_(0/*immediately*/);
        return;

      default:
        if (body.breakpoints) {
          that.updateActiveBreakpoints_(body.breakpoints || []);
        }
        if (Object.keys(that.activeBreakpointMap_).length) {
          that.logger_.breakpoints(Logger.INFO, 'Active Breakpoints:',
            that.activeBreakpointMap_);
        }
        that.scheduleBreakpointFetch_(that.config_.debug.
                                      breakpointUpdateIntervalSec);
        return;
    }
  });
};

/**
 * Given a list of server breakpoints, update our internal list of breakpoints
 * @param {Array.<Breakpoint>} breakpoints
 * @private
 */
Debuglet.prototype.updateActiveBreakpoints_ = function(breakpoints) {
  var that = this;

  var updatedBreakpointMap = this.convertBreakpointListToMap_(breakpoints);
  that.logger_.breakpoints(Logger.INFO, 'Server breakpoints:', updatedBreakpointMap);

  breakpoints.forEach(function(breakpoint) {

    if (!that.completedBreakpointMap_[breakpoint.id] &&
        !that.activeBreakpointMap_[breakpoint.id]) {
      // New breakpoint
      if (!that.addBreakpoint_(breakpoint)) {
        that.completeBreakpoint_(breakpoint);
        return; // no need to schedule expiry.
      }
    }

    // first schedule the expiry of server breakpoints.
    that.scheduleBreakpointExpiry_(breakpoint);
  });

  // Remove completed breakpoints that the server no longer cares about.
  mapSubtract(this.completedBreakpointMap_, updatedBreakpointMap)
    .forEach(function(breakpoint){
      delete this.completedBreakpointMap_[breakpoint.id];
    }, this);

  // Remove active breakpoints that the server no longer care about.
  mapSubtract(this.activeBreakpointMap_, updatedBreakpointMap)
    .forEach(this.removeBreakpoint_, this);
};

/**
 * Array of breakpints get converted to Map of breakpoints, indexed by id
 * @param {Array.<Breakpoint>} breakpointList
 * @return {Object.<string, Breakpoint>} A map of breakpoint IDs to breakpoints.
 * @private
 */
Debuglet.prototype.convertBreakpointListToMap_ = function(breakpointList) {
  var map = {};
  breakpointList.forEach(function(breakpoint) {
    map[breakpoint.id] = breakpoint;
  });
  return map;
};

/**
 * @param {Breakpoint} breakpoint
 * @private
 */
Debuglet.prototype.removeBreakpoint_ = function(breakpoint) {
  delete this.activeBreakpointMap_[breakpoint.id];
  v8debug.clear(breakpoint);
};

/**
 * @param {Breakpoint} breakpoint
 * @return {boolean} false on error
 * @private
 */
Debuglet.prototype.addBreakpoint_ = function(breakpoint) {
  var that = this;

  if (!v8debug.set(breakpoint)) {
    return false;
  }

  this.logger_.info('\tsuccessfully added breakpoint  ' + breakpoint.id);
  that.activeBreakpointMap_[breakpoint.id] = breakpoint;

  v8debug.wait(breakpoint, function(err) {
    if (err) {
      // TODO(ofrobots) what does it mean to come back with an error here?
      // should we remove the breakpoint?
      that.logger_.error('error while waiting for breakpoint', err);
      return false;
    }

    that.logger_.info('Breakpoint hit!: ' + breakpoint.id);
    that.completeBreakpoint_(breakpoint);
  });
  return true;
};

/**
 * Update the server that the breakpoint has been completed (captured, or
 * expired).
 * @param {Breakpoint} breakpoint
 * @private
 */
Debuglet.prototype.completeBreakpoint_ = function(breakpoint) {
  this.logger_.breakpoint(Logger.INFO,
    'Updating breakpoint data on server', breakpoint);
  // TODO: in case of transient errors, retry the update operation
  // Put in the completed breakpoints map only when the update successfully
  // completes. Otherwise - we refuse to set the breakpoint, but the server
  // has never seen the update.
  this.debugletApi_.updateBreakpoint(breakpoint);
  this.completedBreakpointMap_[breakpoint.id] = breakpoint;
  this.removeBreakpoint_(breakpoint);
};

/**
 * @param {number} seconds
 * @private
 */
Debuglet.prototype.scheduleRegistration_ = function(seconds) {
  var that = this;
  setTimeout(this.registerAsDebuggee_.bind(this, function(err) {
    if (err) {
      that.logger_.error('Failed to re-register debuggee: ' + err);
      that.logger_.error('Disabling gcloud debuglet');
      that.stop(); // fatal error
    }
  }), seconds * 1000).unref();
};

/**
 * @param {number} seconds
 * @private
 */
Debuglet.prototype.scheduleBreakpointFetch_ = function(seconds) {
  this.fetcherActive_ = true;
  setTimeout(this.fetchBreakpoints_.bind(this), seconds * 1000).unref();
};

/**
 * This schedules a delayed operation that will delete the breakpoint from the
 * server after the expiry period.
 * FIXME: we should cancel the timer when the breakpoint completes. Otherwise
 * we hold onto the closure memory until the breapointExpirateion timeout.
 * @param {Breakpoint} breakpoint Server breakpoint object
 * @private
 */
Debuglet.prototype.scheduleBreakpointExpiry_ = function(breakpoint) {
  var that = this;

  var now = Date.now() / 1000;
  var createdTime = breakpoint.createdTime ?
    parseInt(breakpoint.createdTime.seconds) : now;
  var expiryTime = createdTime + that.config_.debug.breakpointExpirationSec;

  setTimeout(function() {
    that.logger_.info('Expiring breakpoint ' + breakpoint.id);
    breakpoint.status = {
      description: {
        format: 'The snapshot has expired'
      },
      isError: true,
      refersTo: 'unspecified'
    };
    that.completeBreakpoint_(breakpoint);
  }, (expiryTime - now) * 1000).unref();
};

/**
 * Stops the Debuglet
 */
Debuglet.prototype.stop = function() {
  this.running_ = false;
};


/**
 * Performs a set subtract. Returns A - B given maps A, B.
 * TODO(ofrobots): we need unit tests for this
 * @return {Array.<Breakpoint>} A array containing elements from A that are not
 *     in B.
 */
function mapSubtract(A, B) {
  var removed = [];
  for (var key in A) {
    if (!B[key]) {
      removed.push(A[key]);
    }
  }
  return removed;
}


/**
 * @typedef {Object} Breakpoint
 *
 * Properties used by the Debuglet API.
 * @property {string} id
 * @property {number|undefined} action - Used when updating the breakpoint data
 *     with the Debuglet API. 0 = Capture, 1 = Log
 * @property {SourceLocation} location
 * @property {string|undefined} condition
 * @property {boolean|undefined} isFinalState - Whether the breakpoint data
 *     should be frozen and not accept anymore changes.
 * @property {Array.<StackFrame>|undefined} stackFrames
 * @property {Array.<Variable>|undefined} variableTable - Used to store
 *     variables that are referenced from multiple locations.  The variables
 *     are nameless and get their name from the referencing variable.
 */

/**
 * @typedef {Object} SourceLocation
 * @property {string} path
 * @property {number} line
 */


/**
 * @typedef {Object} StackFrame
 * @property {string} function - The un-mangled name of the function that
 *     contains the code at the frame location.
 * @property {SourceLocation} location
 * @property {Array.<Variable>} arguments - The set of arguments passed into
 *     the frame location's containing function.
 * @property {Array.<Variable>} locals - The set of local variables at the
 *     frame location.
 */

/**
 * @typedef {Object} Variable
 * @property {string} name
 * @property {string|undefined} value - The simple value of the variable.
 * @property {Array.<Variable>|undefined} members - The members contained by
 *     the variable.
 * @property {number|undefined} varIndex - Index of a variable in a Breakpoint's
 *     variable table.
 */
