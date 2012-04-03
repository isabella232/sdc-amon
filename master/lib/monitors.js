/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon Master controller for '/pub/:user/monitors/...' endpoints.
 */

var assert = require('assert');
var events = require('events');
var format = require('util').format;

var uuid = require('node-uuid');
var ldap = require('ldapjs');
var restify = require('restify');
var ufdsmodel = require('./ufdsmodel');
var Contact = require('./contact');
var objCopy = require('amon-common').utils.objCopy;




//---- globals

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;



//---- Monitor model
// Interface is as required by 'ufdsmodel.js'.

/**
 * Create a Monitor. `new Monitor(app, data)`.
 *
 * @param app
 * @param data {Object} The instance data. This can either be the public
 *    representation (augmented with 'name' and 'user'), e.g.:
 *      { name: 'serverHealth',
 *        user: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
 *        contacts: ['fooEmail'] }
 *    or the raw response from UFDS, e.g.:
 *      { dn: 'amonmonitor=serverHealth, uuid=aaa...aaa, ou=users, o=smartdc',
 *        amonmonitor: 'serverHealth',
 *        contact: 'fooEmail',    // this is an array for multiple contacts
 *        objectclass: 'amonmonitor' }
 * @throws {restify.RESTError} if the given data is invalid.
 */
function Monitor(app, data) {
  assert.ok(app);
  assert.ok(data);

  var raw;
  if (data.objectclass) {  // from UFDS
    assert.equal(data.objectclass, Monitor.objectclass);
    this.dn = data.dn;
    raw = objCopy(data);
    delete raw.dn;
    this.user = Monitor.parseDn(data.dn).user;
  } else {
    assert.ok(data.name);
    assert.ok(data.user);
    this.dn = Monitor.dn(data.user, data.name);
    raw = {
      amonmonitor: data.name,
      contact: data.contacts,
      objectclass: Monitor.objectclass
    };
    this.user = data.user;
  }

  Monitor.validateName(raw.amonmonitor);
  this.raw = Monitor.validate(app, raw);

  var self = this;
  this.__defineGetter__('name', function () {
    return self.raw.amonmonitor;
  });
  this.__defineGetter__('contacts', function () {
    return self.raw.contact;
  });
}

Monitor.objectclass = 'amonmonitor';

Monitor.parseDn = function (dn) {
  var parsed = ldap.parseDN(dn);
  return {
    user: parsed.rdns[1].uuid,
    name: parsed.rdns[0].amonmonitor
  };
};


Monitor.dn = function (user, name) {
  return format('amonmonitor=%s, uuid=%s, ou=users, o=smartdc', name, user);
};


Monitor.dnFromRequest = function (req) {
  var name = req.params.name;
  Monitor.validateName(name);
  return Monitor.dn(req._user.uuid, name);
};


Monitor.parentDnFromRequest = function (req) {
  return req._user.dn;
};


/**
 * Return the public API view of this Monitor's data. This differs slightly
 * from the names and structure actually used in UFDS.
 */
Monitor.prototype.serialize = function serialize() {
  return {
    user: this.user,
    name: this.name,
    contacts: this.contacts
  };
};

Monitor.prototype.authorizePut = function (app, callback) {
  callback();
};


/**
 * Get a monitor.
 *
 * @param app {App} The Amon Master App.
 * @param user {String} The monitor owner user UUID.
 * @param name {String} The monitor name.
 * @param callback {Function} `function (err, monitor)`
 */
Monitor.get = function get(app, user, name, callback) {
  if (! UUID_RE.test(user)) {
    throw new restify.InvalidArgumentError(
      format('invalid user UUID: "%s"', user));
  }
  Monitor.validateName(name);
  var dn = Monitor.dn(user, name);
  ufdsmodel.modelGet(app, Monitor, dn, app.log, callback);
};


/**
 * Validate the raw data and optionally massage some fields.
 *
 * @param app {App} The amon-master app.
 * @param raw {Object} The raw UFDS data for this object.
 * @returns {Object} The raw data for this object, possibly massaged to
 *    normalize field values.
 * @throws {restify.RESTError} if the raw data is invalid.
 */
Monitor.validate = function validate(app, raw) {
  var requiredFields = {
    // <raw field name>: <exported name>
    'amonmonitor': 'name',
    'contact': 'contacts'
  };
  Object.keys(requiredFields).forEach(function (field) {
    if (!raw[field]) {
      throw new restify.MissingParameterError(
        format('"%s" is a required parameter', requiredFields[field]));
    }
  });

  if (!(raw.contact instanceof Array)) {
    raw.contact = [raw.contact];
  }
  raw.contact.forEach(function (c) {
    Contact.parseUrn(app, c);
  });

  return raw;
};


/**
 * Validate the given name.
 *
 * @param name {String} The object name.
 * @throws {restify.RESTError} if the name is invalid.
 */
Monitor.validateName = function validateName(name) {
  if (! Monitor._nameRegex.test(name)) {
    throw new restify.InvalidArgumentError(
      format('%s name is invalid: "%s"', Monitor.name, name));
  }
};

// Note: Should be in sync with 'ufds/schema/amonmonitor.js'.
Monitor._nameRegex = /^[a-zA-Z][a-zA-Z0-9_\.-]{0,31}$/;



//---- API endpoints

function apiListMonitors(req, res, next) {
  return ufdsmodel.requestList(req, res, next, Monitor);
}

function apiPutMonitor(req, res, next) {
  return ufdsmodel.requestPut(req, res, next, Monitor);
}

function apiGetMonitor(req, res, next) {
  return ufdsmodel.requestGet(req, res, next, Monitor);
}

function apiDeleteMonitor(req, res, next) {
  //XXX:TODO: handle traversing child Probes and deleting them
  return ufdsmodel.requestDelete(req, res, next, Monitor);
}

/**
 * Fake a fault for this monitor, by sending a 'fake' event.
 * See: <https://mo.joyent.com/docs/amon/master/#FakeMonitorFault>
 */
function apiFakeMonitorFault(req, res, next) {
  if (req.query.action !== 'fakefault')
    return next();

  var userUuid = req._user.uuid;
  var monitorName = req.params.name;
  var clear = (req.query.clear === 'true');
  Monitor.get(req._app, userUuid, monitorName, function (err, monitor) {
    if (err) {
      return next(err);
    }
    var testEvent = {
      v: 1,  //XXX constant for this
      type: 'fake',
      user: req._user.uuid,
      monitor: monitor.name,
      time: Date.now(),
      clear: clear,
      data: {
        message: format('Fake fault%s.', clear ? ' (clear)' : '')
      },
      uuid: uuid()
    };
    req._app.processEvent(testEvent, function (processErr) {
      if (processErr) {
        req.log.error(processErr, 'error processing test event');
        next(new restify.InternalError());
      } else {
        res.send({success: true});
        next(false);
      }
    });
  });
}


/**
 * Mount API endpoints
 *
 * @param server {restify.Server}
 */
function mount(server) {
  server.get({path: '/pub/:user/monitors', name: 'ListMonitors'},
    apiListMonitors);
  server.put({path: '/pub/:user/monitors/:name', name: 'PutMonitor'},
    apiPutMonitor);
  server.get({path: '/pub/:user/monitors/:name', name: 'GetMonitor'},
    apiGetMonitor);
  server.del({path: '/pub/:user/monitors/:name', name: 'DeleteMonitor'},
    apiDeleteMonitor);

  // These update handlers all check "should I run?" based on
  // `req.query.action` and if they should the chain stops.
  server.post({path: '/pub/:user/monitors/:name', name: 'UpdateMonitor'},
    apiFakeMonitorFault,
    function invalidAction(req, res, next) {
      if (req.query.action)
        return next(new restify.InvalidArgumentError(
          '"%s" is not a valid action', req.query.action));
      return next(new restify.MissingParameterError('"action" is required'));
    });
}


//---- controllers

module.exports = {
  Monitor: Monitor,
  mount: mount
};
