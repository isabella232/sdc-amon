/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * The Amon Master app. It defines the master API endpoints.
 */

var http = require('http');
var restify = require('restify');
var amon_common = require('amon-common');

// Endpoint controller modules.
var checks = require('./checks');
var events = require('./events');
var config = require('./config');
var monitors = require('./monitors');
var contacts = require('./contacts');



//---- globals

var Constants = amon_common.Constants;
var log = restify.log;



/**
 * Constructor for the amon "application".
 *
 * @param {Object} options
 *    - port  {Number} The port to listen on.
 *    - config {amon-common.Config} The check config object.
 */
var App = function App(options) {
  if (!options) throw TypeError('options is required');
  if (!options.port) throw TypeError('options.port is required');
  if (!options.config) throw TypeError('options.config is required');

  var self = this;

  this.config = options.config;
  this.port = options.port;
  this.notificationPlugins = {};

  var plugins = options.config.notificationPlugins;
  for (var k in plugins) {
    if (plugins.hasOwnProperty(k)) {
      try {
        this.notificationPlugins[k] = require(plugins[k].path).newInstance(plugins[k].config);
      } catch (e) {
        log.error('Unable to load notification plugin %s: %s', k, e.stack);
      }
    }
  }
  log.debug('Loaded notification plugins: %o', this.notificationPlugins);

  this.server = restify.createServer({
    apiVersion: Constants.ApiVersion,
    serverName: Constants.ServerName
  });

  var _setup = function(req, res, next) {
    req._config = self.config;
    req._log = log;
    req._riak = self.config.riak;
    req._notificationPlugins = self.notificationPlugins;
    return next();
  };

  this.before = [
    _setup
  ];
  this.after = [
    amon_common.w3clog
  ];

  this.server.get('/checks', self.before, checks.list, self.after);
  this.server.post('/checks', self.before, checks.create, self.after);
  this.server.get('/checks/:id', self.before, checks.get, self.after);
  this.server.del('/checks/:id', self.before, checks.del, self.after);
  this.server.head('/config', self.before, config.head, self.after);
  this.server.get('/config', self.before, config.get, self.after);

  this.server.get('/events', self.before, events.list, self.after);
  this.server.post('/events',
                   self.before,
                   amon_common.events.event,
                   events.create,
                   self.after);

  this.server.get('/public/:customer/monitors', self.before, monitors.list, self.after);
  this.server.post('/public/:customer/monitors', self.before, monitors.create, self.after);
  this.server.get('/public/:customer/monitors/:monitor', self.before, monitors.get, self.after);
  this.server.del('/public/:customer/monitors/:monitor', self.before, monitors.del, self.after);

  this.server.get('/public/:customer/contacts', self.before, contacts.list, self.after);
  this.server.put('/public/:customer/contacts/:name', self.before, contacts.put, self.after);
  this.server.get('/public/:customer/contacts/:name', self.before, contacts.get, self.after);
  this.server.del('/public/:customer/contacts/:name', self.before, contacts.del, self.after);
};


/**
 * Gets Application up and listenting.
 *
 * This method creates a zsock with the zone/path you passed in to the
 * constructor.  The callback is of the form function(error), where error
 * should be undefined.
 *
 * @param {Function} callback callback of the form function(error).
 */
App.prototype.listen = function(callback) {
  this.server.listen(this.port, callback);
};


/**
 * Shuts down the zsock in this application's zone.
 *
 * @param {Function} callback called when closed. Takes no arguments.
 */
App.prototype.close = function(callback) {
  var self = this;
  this.server.on('close', function() {
    return callback();
  });
  this.server.close();
};

module.exports = App;
