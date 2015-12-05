// Copyright (c) 2014 Andris Reinman

// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:

// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

(function(root, factory) {
    'use strict';

    if (typeof define === 'function' && define.amd) {
        define(['tcp-socket', 'imap-handler', 'mimefuncs', 'browserbox-compression'], function(TCPSocket, imapHandler, mimefuncs, compression) {
            return factory(TCPSocket, imapHandler, mimefuncs, compression);
        });
    } else if (typeof exports === 'object') {
        module.exports = factory(require('tcp-socket'), require('wo-imap-handler'), require('mimefuncs'), require('./browserbox-compression'), null);
    } else {
        root.BrowserboxImapClient = factory(navigator.TCPSocket, root.imapHandler, root.mimefuncs, root.BrowserboxCompressor);
    }
}(this, function(TCPSocket, imapHandler, mimefuncs, Compression) {
    'use strict';

    //
    // constants used for communication with the worker
    //
    var MESSAGE_START = 'start';
    var MESSAGE_INFLATE = 'inflate';
    var MESSAGE_INFLATED_DATA_READY = 'inflated_ready';
    var MESSAGE_DEFLATE = 'deflate';
    var MESSAGE_DEFLATED_DATA_READY = 'deflated_ready';

    var COMMAND_REGEX = /(\{(\d+)(\+)?\})?\r?\n/;

    /**
     * Creates a connection object to an IMAP server. Call `connect` method to inititate
     * the actual connection, the constructor only defines the properties but does not actually connect.
     *
     * @constructor
     *
     * @param {String} [host='localhost'] Hostname to conenct to
     * @param {Number} [port=143] Port number to connect to
     * @param {Object} [options] Optional options object
     * @param {Boolean} [options.useSecureTransport] Set to true, to use encrypted connection
     * @param {String} [options.compressionWorkerPath] offloads de-/compression computation to a web worker, this is the path to the browserified browserbox-compressor-worker.js
     */
    function ImapClient(host, port, options) {
        this._TCPSocket = TCPSocket;

        this.options = options || {};

        this.port = port || (this.options.useSecureTransport ? 993 : 143);
        this.host = host || 'localhost';

        // Use a TLS connection. Port 993 also forces TLS.
        this.options.useSecureTransport = 'useSecureTransport' in this.options ? !!this.options.useSecureTransport : this.port === 993;

        this.secureMode = !!this.options.useSecureTransport; // Does the connection use SSL/TLS

        this._serverQueue = []; // Queue of received commands
        this._processingServerData = false; // Is there something being processed
        this._connectionReady = false; // Is the conection established and greeting is received from the server

        this._globalAcceptUntagged = {}; // Global handlers for unrelated responses (EXPUNGE, EXISTS etc.)

        this._clientQueue = []; // Queue of outgoing commands
        this._canSend = false; // Is it OK to send something to the server
        this._tagCounter = 0; // Counter to allow uniqueue imap tags
        this._currentCommand = false; // Current command that is waiting for response from the server

        this._idleTimer = false; // Timer waiting to enter idle
        this._socketTimeoutTimer = false; // Timer waiting to declare the socket dead starting from the last write

        this.compressed = false; // Is the connection compressed and needs inflating/deflating
        this._workerPath = this.options.compressionWorkerPath; // The path for the compressor's worker script
        this._compression = new Compression();

        //
        // HELPERS
        //

        // As the server sends data in chunks, it needs to be split into separate lines. Helps parsing the input.
        this._incomingBuffer = '';
        this._command = '';
        this._literalRemaining = 0;

        //
        // Event placeholders, should be overriden
        //
        this.onerror = () => {}; // Irrecoverable error occurred. Connection to the server will be closed automatically.
        this.onready = () => {}; // The connection to the server has been established and greeting is received
        this.onidle = () => {}; // There are no more commands to process
    }

    // Constants

    /**
     * How much time to wait since the last response until the connection is considered idling
     */
    ImapClient.prototype.TIMEOUT_ENTER_IDLE = 1000;

    /**
     * Lower Bound for socket timeout to wait since the last data was written to a socket
     */
    ImapClient.prototype.TIMEOUT_SOCKET_LOWER_BOUND = 10000;

    /**
     * Multiplier for socket timeout:
     *
     * We assume at least a GPRS connection with 115 kb/s = 14,375 kB/s tops, so 10 KB/s to be on
     * the safe side. We can timeout after a lower bound of 10s + (n KB / 10 KB/s). A 1 MB message
     * upload would be 110 seconds to wait for the timeout. 10 KB/s === 0.1 s/B
     */
    ImapClient.prototype.TIMEOUT_SOCKET_MULTIPLIER = 0.1;

    // PUBLIC METHODS

    /**
     * Initiate a connection to the server. Wait for onready event
     */
    ImapClient.prototype.connect = function() {
        return new Promise((resolve, reject) => {
            this.socket = this._TCPSocket.open(this.host, this.port, {
                binaryType: 'arraybuffer',
                useSecureTransport: this.secureMode,
                ca: this.options.ca,
                tlsWorkerPath: this.options.tlsWorkerPath
            });

            // allows certificate handling for platform w/o native tls support
            // oncert is non standard so setting it might throw if the socket object is immutable
            try {
                this.socket.oncert = this.oncert;
            } catch (E) {}

            // Connection closing unexpected is an error
            this.socket.onclose = () => this._onError(new Error('Socket closed unexceptedly!'));
            this.socket.ondata = (evt) => this._onData(evt);

            // if an error happens during create time, reject the promise
            this.socket.onerror = (e) => {
                reject(new Error('Could not open socket: ' + e.data.message));
            };

            this.socket.onopen = () => {
                // use proper "irrecoverable error, tear down everything"-handler only after socket is open
                this.socket.onerror = (e) => this._onError(e);
                resolve();
            };
        });
    };

    /**
     * Closes the connection to the server
     */
    ImapClient.prototype.close = function() {
        return new Promise((resolve) => {
            var tearDown = () => {
                this._serverQueue = [];
                this._clientQueue = [];
                this._currentCommand = false;
                clearTimeout(this._idleTimer);
                clearTimeout(this._socketTimeoutTimer);

                if (this.socket) {
                    // remove all listeners
                    this.socket.onclose = () => {};
                    this.socket.ondata = () => {};
                    this.socket.ondrain = () => {};
                    this.socket.onerror = () => {};
                }

                resolve();
            };

            this._disableCompression();

            if (!this.socket || this.socket.readyState !== 'open') {
                return tearDown();
            }

            this.socket.onclose = this.socket.onerror = tearDown; // we don't really care about the error here
            this.socket.close();
        });
    };

    ImapClient.prototype.logout = function() {
        return new Promise((resolve, reject) => {
            this.socket.onclose = this.socket.onerror = () => {
                this.close().then(resolve).catch(reject);
            };

            this.enqueueCommand('LOGOUT');
        });
    };

    /**
     * Closes the connection to the server
     */
    ImapClient.prototype.upgrade = function() {
        this.secureMode = true;
        this.socket.upgradeToSecure();
    };

    /**
     * Schedules a command to be sent to the server. This method is chainable.
     * See https://github.com/Kreata/imapHandler for request structure.
     * Do not provide a tag property, it will be set byt the queue manager.
     *
     * To catch untagged responses use acceptUntagged property. For example, if
     * the value for it is 'FETCH' then the reponse includes 'payload.FETCH' property
     * that is an array including all listed * FETCH responses.
     *
     * Callback function provides 2 arguments, parsed response object and continue callback.
     *
     *   function(response, next){
     *     console.log(response);
     *     next();
     *   }
     *
     * @param {Object} request Structured request object
     * @param {Array} acceptUntagged a list of untagged responses that will be included in 'payload' property
     * @param {Object} [options] Optional data for the command payload
     * @param {Function} callback Callback function to run once the command has been processed
     */
    ImapClient.prototype.enqueueCommand = function(request, acceptUntagged, options) {
        if (typeof request === 'string') {
            request = {
                command: request
            };
        }

        acceptUntagged = [].concat(acceptUntagged || []).map((untagged) => (untagged || '').toString().toUpperCase().trim());

        var tag = 'W' + (++this._tagCounter);
        request.tag = tag;

        return new Promise((resolve, reject) => {
            var data = {
                tag: tag,
                request: request,
                payload: acceptUntagged.length ? {} : undefined,
                callback: (response) => {
                    if (this.isError(response)) {
                        return reject(response);
                    } else if (['NO', 'BAD'].indexOf((response && response.command || '').toString().toUpperCase().trim()) >= 0) {
                        const error = new Error(response.humanReadable || 'Error');
                        if (response.code) {
                            error.code = response.code;
                        }
                        return reject(error);
                    }

                    resolve(response);
                }
            };

            // apply any additional options to the command
            Object.keys(options || {}).forEach((key) => data[key] = options[key]);

            acceptUntagged.forEach((command) => data.payload[command] = []);

            this._clientQueue.push(data);

            if (this._canSend) {
                this._sendRequest();
            }
        });
    };

    /**
     * Send data to the TCP socket
     * Arms a timeout waiting for a response from the server.
     *
     * @param {String} str Payload
     */
    ImapClient.prototype.send = function(str) {
        var buffer = mimefuncs.toTypedArray(str).buffer,
            timeout = this.TIMEOUT_SOCKET_LOWER_BOUND + Math.floor(buffer.byteLength * this.TIMEOUT_SOCKET_MULTIPLIER);

        clearTimeout(this._socketTimeoutTimer); // clear pending timeouts
        this._socketTimeoutTimer = setTimeout(() => this._onError(new Error(this.options.sessionId + ' Socket timed out!')), timeout); // arm the next timeout

        if (this.compressed) {
            this._sendCompressed(buffer);
        } else {
            this.socket.send(buffer);
        }
    };

    /**
     * Set a global handler for an untagged response. If currently processed command
     * has not listed untagged command it is forwarded to the global handler. Useful
     * with EXPUNGE, EXISTS etc.
     *
     * @param {String} command Untagged command name
     * @param {Function} callback Callback function with response object and continue callback function
     */
    ImapClient.prototype.setHandler = function(command, callback) {
        this._globalAcceptUntagged[command.toUpperCase().trim()] = callback;
    };

    // INTERNAL EVENTS

    /**
     * Error handler for the socket
     *
     * @event
     * @param {Event} evt Event object. See evt.data for the error
     */
    ImapClient.prototype._onError = function(evt) {
        this.close().then(() => {
            if (this.isError(evt)) {
                this.onerror(evt);
            } else if (evt && this.isError(evt.data)) {
                this.onerror(evt.data);
            } else {
                this.onerror(new Error(evt && evt.data && evt.data.message || evt.data || evt || 'Error'));
            }
        });
    };

    /**
     * Handler for incoming data from the server. The data is sent in arbitrary
     * chunks and can't be used directly so this function makes sure the data
     * is split into complete lines before the data is passed to the command
     * handler
     *
     * @param {Event} evt
     */
    ImapClient.prototype._onData = function(evt) {
        var match;

        clearTimeout(this._socketTimeoutTimer); // clear the timeout, the socket is still up
        this._incomingBuffer += mimefuncs.fromTypedArray(evt.data); // append to the incoming buffer

        // The input is interesting as long as there are complete lines
        while ((match = this._incomingBuffer.match(COMMAND_REGEX))) {
            if (this._literalRemaining && this._literalRemaining > this._incomingBuffer.length) {
                // we're expecting more incoming literal data than available, wait for the next chunk
                return;
            }

            if (this._literalRemaining) {
                // we're expecting incoming literal data:
                // take portion of pending literal data from the chunk, parse the remaining buffer in the next iteration
                this._command += this._incomingBuffer.substr(0, this._literalRemaining);
                this._incomingBuffer = this._incomingBuffer.substr(this._literalRemaining);
                this._literalRemaining = 0;
                continue;
            }

            if (match[2]) {
                // we have a literal data command:
                // take command portion (match.index) including the literal data octet count (match[0].length)
                // from the chunk, parse the literal data in the next iteration
                this._literalRemaining = Number(match[2]);
                this._command += this._incomingBuffer.substr(0, match.index + match[0].length);
                this._incomingBuffer = this._incomingBuffer.substr(match.index + match[0].length);
                continue;
            }

            // we have a complete command, pass on to processing
            this._command += this._incomingBuffer.substr(0, match.index);
            this._incomingBuffer = this._incomingBuffer.substr(match.index + match[0].length);
            this._addToServerQueue(this._command);

            this._command = ''; // clear for next iteration
        }
    };

    // PRIVATE METHODS

    /**
     * Pushes command line from the server to the server processing queue. If the
     * processor is idle, start processing.
     *
     * @param {String} cmd Command line
     */
    ImapClient.prototype._addToServerQueue = function(cmd) {
        this._serverQueue.push(cmd);

        if (this._processingServerData) {
            return;
        }

        this._processingServerData = true;
        this._processServerQueue();
    };

    /**
     * Process a command from the queue. The command is parsed and feeded to a handler
     */
    ImapClient.prototype._processServerQueue = function() {
        if (!this._serverQueue.length) {
            this._processingServerData = false;
            return;
        } else {
            this._clearIdle();
        }

        var data = this._serverQueue.shift(),
            response;

        try {
            // + tagged response is a special case, do not try to parse it
            if (/^\+/.test(data)) {
                response = {
                    tag: '+',
                    payload: data.substr(2) || ''
                };
            } else {
                response = imapHandler.parser(data);
                // console.log(this.options.sessionId + ' S: ' + imapHandler.compiler(response, false, true));
            }
        } catch (e) {
            console.error(this.options.sessionId + ' error parsing imap response: ' + e + '\n' + e.stack + '\nraw:' + data);
            return this._onError(e);
        }

        if (response.tag === '*' &&
            /^\d+$/.test(response.command) &&
            response.attributes && response.attributes.length && response.attributes[0].type === 'ATOM') {
            response.nr = Number(response.command);
            response.command = (response.attributes.shift().value || '').toString().toUpperCase().trim();
        }

        // feed the next chunk to the server if a + tagged response was received
        if (response.tag === '+') {
            if (this._currentCommand.data.length) {
                data = this._currentCommand.data.shift();
                this.send(data + (!this._currentCommand.data.length ? '\r\n' : ''));
            } else if (typeof this._currentCommand.errorResponseExpectsEmptyLine) {
                // OAuth2 login expects an empty line if login failed
                this.send('\r\n');
            }
            setTimeout(() => this._processServerQueue(), 0);
            return;
        }

        this._processServerResponse(response, (err) => {
            if (err) {
                return this._onError(err);
            }

            // first response from the server, connection is now usable
            if (!this._connectionReady) {
                this._connectionReady = true;
                this.onready();
                this._canSend = true;
                this._sendRequest();
            } else if (response.tag !== '*') {
                // allow sending next command after full response
                this._canSend = true;
                this._sendRequest();
            }

            setTimeout(() => this._processServerQueue(), 0);
        });
    };

    /**
     * Feeds a parsed response object to an appropriate handler
     *
     * @param {Object} response Parsed command object
     * @param {Function} callback Continue callback function
     */
    ImapClient.prototype._processServerResponse = function(response, callback) {
        var command = (response && response.command || '').toUpperCase().trim();

        this._processResponse(response);

        if (!this._currentCommand) {
            if (response.tag === '*' && command in this._globalAcceptUntagged) {
                this._globalAcceptUntagged[command](response);
            }

            return callback();
        }

        if (this._currentCommand.payload && response.tag === '*' && command in this._currentCommand.payload) {
            this._currentCommand.payload[command].push(response);
            return callback();

        } else if (response.tag === '*' && command in this._globalAcceptUntagged) {
            this._globalAcceptUntagged[command](response, callback);
            return callback();

        } else if (response.tag === this._currentCommand.tag) {

            if (typeof this._currentCommand.callback === 'function') {

                if (this._currentCommand.payload && Object.keys(this._currentCommand.payload).length) {
                    response.payload = this._currentCommand.payload;
                }

                this._currentCommand.callback(response);
                return callback();
            } else {
                return callback();
            }

        } else {
            // Unexpected response
            return callback();
        }
    };

    /**
     * Sends a command from client queue to the server.
     */
    ImapClient.prototype._sendRequest = function() {
        if (!this._clientQueue.length) {
            return this._enterIdle();
        }
        this._clearIdle();

        this._canSend = false;
        this._currentCommand = this._clientQueue.shift();
        var loggedCommand = false;

        try {
            this._currentCommand.data = imapHandler.compiler(this._currentCommand.request, true);
            loggedCommand = imapHandler.compiler(this._currentCommand.request, false, true);
        } catch (e) {
            console.error(this.options.sessionId + ' error compiling imap command: ' + e + '\nstack trace: ' + e.stack + '\nraw:' + this._currentCommand.request);
            return this._onError(e);
        }

        // console.log(this.options.sessionId + ' C: ' + loggedCommand);
        var data = this._currentCommand.data.shift();

        this.send(data + (!this._currentCommand.data.length ? '\r\n' : ''));
        return this.waitDrain;
    };

    /**
     * Emits onidle, noting to do currently
     */
    ImapClient.prototype._enterIdle = function() {
        clearTimeout(this._idleTimer);
        this._idleTimer = setTimeout(() => this.onidle(), this.TIMEOUT_ENTER_IDLE);
    };

    /**
     * Cancel idle timer
     */
    ImapClient.prototype._clearIdle = function() {
        clearTimeout(this._idleTimer);
    };

    // HELPER FUNCTIONS

    /**
     * Method checks if a response includes optional response codes
     * and copies these into separate properties. For example the
     * following response includes a capability listing and a human
     * readable message:
     *
     *     * OK [CAPABILITY ID NAMESPACE] All ready
     *
     * This method adds a 'capability' property with an array value ['ID', 'NAMESPACE']
     * to the response object. Additionally 'All ready' is added as 'humanReadable' property.
     *
     * See possiblem IMAP Response Codes at https://tools.ietf.org/html/rfc5530
     *
     * @param {Object} response Parsed response object
     */
    ImapClient.prototype._processResponse = function(response) {
        var command = (response && response.command || '').toString().toUpperCase().trim(),
            option,
            key;

        if (['OK', 'NO', 'BAD', 'BYE', 'PREAUTH'].indexOf(command) >= 0) {
            // Check if the response includes an optional response code
            if (
                (option = response && response.attributes &&
                    response.attributes.length && response.attributes[0].type === 'ATOM' &&
                    response.attributes[0].section && response.attributes[0].section.map((key) => {
                        if (!key) {
                            return;
                        }
                        if (Array.isArray(key)) {
                            return key.map((key) => (key.value || '').toString().trim());
                        } else {
                            return (key.value || '').toString().toUpperCase().trim();
                        }
                    }))) {

                key = option && option.shift();

                response.code = key;

                if (option.length) {
                    option = [].concat(option || []);
                    response[key.toLowerCase()] = option.length === 1 ? option[0] : option;
                }
            }

            // If last element of the response is TEXT then this is for humans
            if (response && response.attributes && response.attributes.length &&
                response.attributes[response.attributes.length - 1].type === 'TEXT') {

                response.humanReadable = response.attributes[response.attributes.length - 1].value;
            }
        }
    };

    /**
     * Checks if a value is an Error object
     *
     * @param {Mixed} value Value to be checked
     * @return {Boolean} returns true if the value is an Error
     */
    ImapClient.prototype.isError = function(value) {
        return !!Object.prototype.toString.call(value).match(/Error\]$/);
    };

    // COMPRESSION RELATED METHODS

    /**
     * Sets up deflate/inflate for the IO
     */
    ImapClient.prototype.enableCompression = function() {
        this._socketOnData = this.socket.ondata;
        this.compressed = true;

        if (typeof window !== 'undefined' && window.Worker && typeof this._workerPath === 'string') {

            //
            // web worker support
            //

            this._compressionWorker = new Worker(this._workerPath);
            this._compressionWorker.onmessage = (e) => {
                var message = e.data.message,
                    buffer = e.data.buffer;

                switch (message) {
                    case MESSAGE_INFLATED_DATA_READY:
                        this._socketOnData({
                            data: buffer
                        });
                        break;

                    case MESSAGE_DEFLATED_DATA_READY:
                        this.waitDrain = this.socket.send(buffer);
                        break;

                }
            };

            this._compressionWorker.onerror = (e) => {
                var error = new Error('Error handling compression web worker: Line ' + e.lineno + ' in ' + e.filename + ': ' + e.message);
                console.error(error);
                this._onError(error);
            };

            // first message starts the worker
            this._compressionWorker.postMessage(this._createMessage(MESSAGE_START));

        } else {

            //
            // without web worker support
            //

            this._compression.inflatedReady = (buffer) => {
                // emit inflated data
                this._socketOnData({
                    data: buffer
                });
            };

            this._compression.deflatedReady = (buffer) => {
                // write deflated data to socket
                if (!this.compressed) {
                    return;
                }

                this.waitDrain = this.socket.send(buffer);
            };
        }

        // override data handler, decompress incoming data
        this.socket.ondata = (evt) => {
            if (!this.compressed) {
                return;
            }

            // inflate
            if (this._compressionWorker) {
                this._compressionWorker.postMessage(this._createMessage(MESSAGE_INFLATE, evt.data), [evt.data]);
            } else {
                this._compression.inflate(evt.data);
            }
        };
    };



    /**
     * Undoes any changes related to compression. This only be called when closing the connection
     */
    ImapClient.prototype._disableCompression = function() {
        if (!this.compressed) {
            return;
        }

        this.compressed = false;
        this.socket.ondata = this._socketOnData;
        this._socketOnData = null;

        if (this._compressionWorker) {
            // terminate the worker
            this._compressionWorker.terminate();
            this._compressionWorker = null;
        }
    };

    /**
     * Outgoing payload needs to be compressed and sent to socket
     *
     * @param {ArrayBuffer} buffer Outgoing uncompressed arraybuffer
     */
    ImapClient.prototype._sendCompressed = function(buffer) {
        // deflate
        if (this._compressionWorker) {
            this._compressionWorker.postMessage(this._createMessage(MESSAGE_DEFLATE, buffer), [buffer]);
        } else {
            this._compression.deflate(buffer);
        }
    };

    ImapClient.prototype._createMessage = function(message, buffer) {
        return {
            message: message,
            buffer: buffer
        };
    };


    return ImapClient;
}));
