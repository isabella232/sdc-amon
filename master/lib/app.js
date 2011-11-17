/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * The Amon Master app. It defines the master API endpoints.
 */

var http = require('http');
var assert = require('assert');

var ldap = require('ldapjs');
var restify = require('restify');

var amonCommon = require('amon-common');
var Cache = amonCommon.Cache;
var Constants = amonCommon.Constants;

// Endpoint controller modules.
var contacts = require('./contacts');
var Contact = contacts.Contact;
var monitors = require('./monitors');
var Monitor = monitors.Monitor;
var probes = require('./probes');
var agentprobes = require('./agentprobes');
var events = require('./events');



//---- globals

var log = restify.log;



//---- internal support stuff

function ping(req, res, next) {
  var data = {
    ping: "pong",
  };
  res.send(200, data);
  return next();
}

function getAccount(req, res, next) {
  account = req._account;
  var data = {
    login: account.login,
    email: account.email,
    id: account.uuid,
    firstName: account.cn,
    lastName: account.sn
  };
  res.send(200, data);
  return next();
}


/**
 * Run async `fn` on each entry in `list`. Call `cb(error)` when all done.
 * `fn` is expected to have `fn(item, callback) -> callback(error)` signature.
 *
 * From Isaac's rimraf.js.
 */
function asyncForEach(list, fn, cb) {
  if (!list.length) cb()
  var c = list.length
    , errState = null
  list.forEach(function (item, i, list) {
   fn(item, function (er) {
      if (errState) return
      if (er) return cb(errState = er)
      if (-- c === 0) return cb()
    })
  })
}



//---- exports

/**
 * Create the app.
 *
 * @param config {Object} The amon master config object.
 * @param callback {Function} `function (err, app) {...}`.
 */
function createApp(config, callback) {
  var ufds = ldap.createClient({
    url: config.ufds.url
  }); 
  
  var opts;
  opts = {
    filter: '(login=*)',
    scope: 'sub'
  };
  
  ufds.bind('cn=root', 'secret', function(err) {
    if (err) {
      return callback(err);
    }
    var app = new App(config, ufds);
    return callback(null, app);
  });
}



/**
 * Constructor for the amon "application".
 *
 * @param config {Object} Config object.
 * @param ufds {ldapjs.Client} LDAP client to UFDS.
 */
function App(config, ufds) {
  var self = this;

  if (!config) throw TypeError('config is required');
  if (!config.port) throw TypeError('config.port is required');
  if (!ufds) throw TypeError('ufds is required');
  this.config = config;
  this.ufds = ufds;

  this.notificationPlugins = {};
  if (config.notificationPlugins) {
    Object.keys(config.notificationPlugins || {}).forEach(function (name) {
      var plugin = config.notificationPlugins[name];
      log.info("Loading '%s' notification plugin.", name);
      self.notificationPlugins[name] = require(plugin.path).newInstance(plugin.config);
    });
  }

  // Cache of login (aka username) -> full account record.
  this.accountCache = new Cache(config.accountCache.size,
    config.accountCache.expiry, log, "account");

  var server = this.server = restify.createServer({
    apiVersion: Constants.ApiVersion,
    serverName: Constants.ServerName
  });

  function setup(req, res, next) {
    req._app = self;
    req._ufds = self.ufds;
    req._log = log;
    //req._notificationPlugins = self.notificationPlugins;

    // Handle ':login' in route: add `req._account` or respond with 404 or
    // 500.
    var login = req.uriParams.login;
    if (login) {
      self.accountFromLogin(login, function (err, account) {
        if (err) {
          req._log.debug("Error getting account for login '%s': %s",
            login, err);
          res.send(500);
          return next();
        } else if (! account) {
          req._log.debug("No getting account for login '%s': %s",
            login, err);
          //XXX Structured error response.
          res.send(404, "No such login, '"+login+"'.");
        } else {
          req._account = account;
          return next();
        }
      });
    } else {
      return next();
    }
  };

  var before = [setup];
  var after = [restify.log.w3c];

  server.get('/ping', before, ping, after);

  server.get('/pub/:login', before, getAccount, after);
  
  server.get('/pub/:login/contacts', before, contacts.listContacts, after);
  server.put('/pub/:login/contacts/:contact', before, contacts.createContact, after);
  server.get('/pub/:login/contacts/:contact', before, contacts.getContact, after);
  server.del('/pub/:login/contacts/:contact', before, contacts.deleteContact, after);
  
  server.get('/pub/:login/monitors', before, monitors.listMonitors, after);
  server.put('/pub/:login/monitors/:monitor', before, monitors.createMonitor, after);
  server.get('/pub/:login/monitors/:monitor', before, monitors.getMonitor, after);
  server.del('/pub/:login/monitors/:monitor', before, monitors.deleteMonitor, after);
  
  server.get('/pub/:login/monitors/:monitor/probes', before, probes.listProbes, after);
  server.put('/pub/:login/monitors/:monitor/probes/:probe', before, probes.createProbe, after);
  server.get('/pub/:login/monitors/:monitor/probes/:probe', before, probes.getProbe, after);
  server.del('/pub/:login/monitors/:monitor/probes/:probe', before, probes.deleteProbe, after);
  
  server.get('/agentprobes', before, agentprobes.listAgentProbes, after);
  server.head('/agentprobes', before, agentprobes.listAgentProbes, after);
  
  server.post('/events', before, events.addEvents, after);
};


/**
 * Gets Application up and listening.
 *
 * This method creates a zsock with the zone/path you passed in to the
 * constructor.  The callback is of the form function(error), where error
 * should be undefined.
 *
 * @param {Function} callback callback of the form function(error).
 */
App.prototype.listen = function(callback) {
  this.server.listen(this.config.port, callback);
};


/**
 * Facilitate getting account info (and caching it) from a login/username.
 *
 * @param login {String} Login (aka username) of the account to get.
 * @param callback {Function} `function (err, account)`. Currently "err"
 *    isn't well standardized. If the given username is not found this
 *    will call `callback(null, null)`.
 */
App.prototype.accountFromLogin = function(login, callback) {
  // Validate args.
  if (!login) throw new TypeError('login is required');
  // Ensure "login" doesn't have LDAP search meta chars.
  var VALID_LOGIN_CHARS = /^[a-zA-Z][a-zA-Z0-9_\.@]+$/;
  if (! VALID_LOGIN_CHARS.test(login)) {
    throw new Error("invalid characters in login: '"+login+"'");
  }
  if (!callback || typeof(callback) !== 'function')
    throw new TypeError('callback is required (function)');
  
  // Check cache. "cached" is `{err: <error>, account: <account>}`.
  var cached = this.accountCache.get(login);
  if (cached) {
    if (cached.err)
      return callback(cached.err);
    return callback(null, cached.account);
  }

  var self = this;
  function cacheAndCallback(err, account) {
    self.accountCache.put(login, {err: err, account: account});
    return callback(err, account);
  }

  // Look up the login, cache the result and return.
  var opts = {
    filter: '(&(login=' + login + ')(objectclass=sdcperson))',
    scope: 'sub'
  };
  this.ufds.search("o=smartdc", opts, function(err, result) {
    var accounts = [];
    result.on('searchEntry', function(entry) {
      accounts.push(entry.object);
    });

    result.on('error', function(err) {
      return cacheAndCallback(err);
    });

    result.on('end', function(result) {
      if (result.status !== 0) {
        return cacheAndCallback("non-zero status from LDAP search: "+result);
      }
      log.debug('accounts: %o', accounts);
      switch (accounts.length) {
      case 0:
        return cacheAndCallback(null, null);
        break;
      case 1:
        return cacheAndCallback(null, accounts[0]);
        break;
      default:
        return cacheAndCallback("unexpected number of accounts ("
          + accounts.length + ") matching login='" + login + "': "
          + JSON.stringify(accounts));
      }
    });
  });
  
};


/**
 * Handle an incoming event.
 *
 * @param ufds {ldapjs client} UFDS client.
 * @param event {Object} The event object.
 * @param callback {Function} `function (err) {}` called on completion.
 *    "err" is undefined (success) or an error message (failure).
 *
 * An example monitor (beware this being out of date):
{
  "probe": {
    "user": "7b23ae63-37c9-420e-bb88-8d4bf5e30455",
    "monitor": "whistle",
    "name": "whistlelog2",
    "type": "amon:logscan"
  },
  "type": "Integer",
  "value": 1,
  "data": {
    "match": "tweet tweet"
  },
  "uuid": "3ab1336e-5453-45f9-be10-8686ba70e419",
  "version": "1.0.0"
}
 */
App.prototype.processEvent = function (event, callback) {
  var self = this;
  log.debug("App.processEvent: %o", event);
  
  // 1. Get the monitor for this probe, to get its list of contacts.
  var userUuid = event.probe.user;
  Monitor.get(this.ufds, event.probe.monitor, userUuid, function (err, monitor) {
    if (err) return callback(err);
    // 2. Notify each contact.
    function getAndNotifyContact(contactName, cb) {
      log.debug("App.processEvent: notify contact '%s'", contactName);
      Contact.get(self.ufds, contactName, userUuid, function (err, contact) {
        if (err) {
          log.warn("could not get contact '%s' (user '%s'): %s",
            contactName, userUuid, err)
          return cb();
        }
        self.notifyContact(userUuid, monitor, contact, event, function (err) {
          if (err) {
            log.warn("could not notify contact: %s", err);
          }
          return cb();
        });
      });
    }
    asyncForEach(monitor.contacts, getAndNotifyContact, function (err) {
      callback();
    });
  });
};

/**
 * XXX clarify error handling
 *
 * ...
 * @param callback {Function} `function (err) {}`.
 */
App.prototype.notifyContact = function (user, monitor, contact, event, callback) {
  var plugin = this.notificationPlugins[contact.medium];
  if (!plugin) {
    return callback("notification plugin '%s' not found", contact.medium);
  }
  plugin.notify(event.probe.name, contact.data, "XXX message", callback);
}


/**
 * Close this app.
 * 
 * @param {Function} callback called when closed. Takes no arguments.
 */
App.prototype.close = function(callback) {
  var self = this;
  this.server.on('close', function() {
    self.ufds.unbind(function() {
      return callback();
    });
  });
  this.server.close();
};



module.exports.createApp = createApp;
module.exports.App = App;
