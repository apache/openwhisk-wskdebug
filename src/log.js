/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const dbg = require('debug');
const ora = require('ora');
const chalk = require('chalk');

const INFO_COLOR_ANSI = 36;
const infoColor = chalk.ansi(INFO_COLOR_ANSI);
const highlightColor = chalk.magenta;

const spinner = ora({
    color: "cyan",
    stream: process.stdout
});

const DEBUG_NAMESPACE = "wskdebug"
const debug = dbg(DEBUG_NAMESPACE);

const noop = () => {};

// no emoji support in windows terminal
const useEmoji = process.platform !== 'win32' || process.env.CI || process.env.TERM === 'xterm-256color';
const symbols = useEmoji ? {
    step: '❯',
    success: '✔',
    ready: '🚀'
} : {
    step: '-',
    success: '√',
    ready: '>'
};

if (debug.enabled || !spinner.isEnabled) {
    // disable spinner since we have all the debug() logs saying similar stuff
    spinner.start = noop;
    spinner.stop = noop;
}

let originalConsole = null;

module.exports = {

    isVerbose: false,

    quiet: function(quiet) {
        if (quiet) {
            // quiet wins
            this.isVerbose = false;
            dbg.disable();

            this.log = noop;
            this.step = noop;
            this.highlight = noop;
            this.warn = noop;
            this.verboseWrite = noop;
            this.deepObject = noop;
            spinner.start = noop;
            spinner.stopAndPersist = noop;
        }
    },

    /** Important step message, prefixed with symbol, visible by default. Ends any running spinner(). */
    step: function(text) {
        spinner.stopAndPersist({
            symbol: infoColor(symbols.step),
            text: spinner.isEnabled ? infoColor(text) : text
        });
    },

    highlight: function(text, highlight) {
        this.step(text + highlightColor(highlight));
    },

    highlightColor,

    /** Basic log message, visible by default. Ends any running spinner(). */
    log: function(...args) {
        spinner.stop();
        // goes to stdout
        console.info(...args);
    },

    /** Warning message, visible by default. Ends any running spinner(). */
    warn: function(...args) {
        spinner.stop();
        // goes to stderr
        console.warn(...args);
    },

    /** Error message, visible by default. Ends any running spinner(). */
    error: function(...args) {
        spinner.stop();
        // goes to stderr
        console.error(...args);
    },

    verbose: function(...args) {
        if (this.isVerbose) {
            this.log(...args);
        }
    },

    verboseStep: function(...args) {
        if (this.isVerbose) {
            this.step(...args);
        }
    },

    verboseWrite: function(text) {
        if (this.isVerbose) {
            process.stdout.write(text);
        }
    },

    exception: function(err, message="Error:") {
        // stacktrace only in verbose
        if (this.isVerbose) {
            this.error(err);
        } else {
            this.error(message, err.message);
        }
    },

    deepObject: function(obj) {
        console.dir(obj, { depth: null });
    },

    // common debug() instance for shared time spent measurments (+millis)
    debug,

    /**
     * Create a new "child" debug instance for logging times in parallel promises
     */
    newDebug: function() {
        const debug = dbg(DEBUG_NAMESPACE);
        // trick to start time measurement from now on without logging an extra line
        debug.log = () => {};
        debug();
        delete debug.log;
        return debug;
    },

    /** Start a spinner on the console */
    spinner: function(text) {
        spinner.start(infoColor(text) + " ");
    },

    /** Stop a running spinner().  */
    stopSpinner: function() {
        spinner.stop();
    },

    resumeSpinner: function() {
        if (spinner.text) {
            this.spinner(spinner.text);
        }
    },

    /** Finish any running spinner and show a log message with a success symbol in front. */
    succeed: function(text) {
        spinner.stopAndPersist({
            symbol: chalk.green(symbols.success),
            text: infoColor(text)
        });
    },

    /** Finish any running spinner and show a log message with a ready symbol in front. */
    ready: function(text) {
        spinner.stopAndPersist({
            symbol: infoColor(symbols.ready),
            text: infoColor(text)
        });
    },

    enableConsoleColors: function() {
        // colorful console.log() and co
        if (!console._logToFile) {
            originalConsole = {
                log: console.log,
                error: console.error,
                info: console.info,
                debug: console.debug
            };
            // overwrites console.*()
            const manakin = require('manakin').global;
            manakin.info.color = INFO_COLOR_ANSI;

            // no bright as it might not look good on terminals with white background
            //manakin.setBright();
        }
        return originalConsole;
    },

    resetConsoleColors: function() {
        if (originalConsole) {
            console.log = originalConsole.log;
            console.error = originalConsole.error;
            console.info = originalConsole.info;
            console.debug = originalConsole.debug;
        }
    },

    isInteractive: spinner.isEnabled
};

if (process.env.WSKDEBUG_QUIET === "1") {
    module.exports.quiet(true);
}
