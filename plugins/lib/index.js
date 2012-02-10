/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon probe types (aka plugins). This exports a mapping of probe type
 * to probe class. See "plugin.js" module comment for API details.
 */

module.exports = {
  'logscan': require('./logscan'),
  'machine-up': require('./machine-up')
};
