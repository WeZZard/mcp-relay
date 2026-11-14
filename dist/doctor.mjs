#!/usr/bin/env node
import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/ws/lib/constants.js
var require_constants = __commonJS({
  "node_modules/ws/lib/constants.js"(exports, module) {
    "use strict";
    var BINARY_TYPES = ["nodebuffer", "arraybuffer", "fragments"];
    var hasBlob = typeof Blob !== "undefined";
    if (hasBlob) BINARY_TYPES.push("blob");
    module.exports = {
      BINARY_TYPES,
      CLOSE_TIMEOUT: 3e4,
      EMPTY_BUFFER: Buffer.alloc(0),
      GUID: "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      hasBlob,
      kForOnEventAttribute: /* @__PURE__ */ Symbol("kIsForOnEventAttribute"),
      kListener: /* @__PURE__ */ Symbol("kListener"),
      kStatusCode: /* @__PURE__ */ Symbol("status-code"),
      kWebSocket: /* @__PURE__ */ Symbol("websocket"),
      NOOP: () => {
      }
    };
  }
});

// node_modules/ws/lib/buffer-util.js
var require_buffer_util = __commonJS({
  "node_modules/ws/lib/buffer-util.js"(exports, module) {
    "use strict";
    var { websocketMask, websocketUnmask } = __require("http");
    var { EMPTY_BUFFER } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    function concat(list, totalLength) {
      if (list.length === 0) return EMPTY_BUFFER;
      if (list.length === 1) return list[0];
      const target = Buffer.allocUnsafe(totalLength);
      let offset = 0;
      for (let i = 0; i < list.length; i++) {
        const buf = list[i];
        target.set(buf, offset);
        offset += buf.length;
      }
      if (offset < totalLength) {
        return new FastBuffer(target.buffer, target.byteOffset, offset);
      }
      return target;
    }
    function _mask(source, mask, output, offset, length) {
      for (let i = 0; i < length; i++) {
        output[offset + i] = source[i] ^ mask[i & 3];
      }
    }
    function _unmask(buffer, mask) {
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] ^= mask[i & 3];
      }
    }
    function toArrayBuffer(buf) {
      if (buf.length === buf.buffer.byteLength) {
        return buf.buffer;
      }
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
    }
    function toBuffer(data) {
      toBuffer.readOnly = true;
      if (Buffer.isBuffer(data)) return data;
      let buf;
      if (data instanceof ArrayBuffer) {
        buf = new FastBuffer(data);
      } else if (ArrayBuffer.isView(data)) {
        buf = new FastBuffer(data.buffer, data.byteOffset, data.byteLength);
      } else {
        buf = Buffer.from(data);
        toBuffer.readOnly = false;
      }
      return buf;
    }
    module.exports = {
      concat,
      mask: _mask,
      toArrayBuffer,
      toBuffer,
      unmask: _unmask
    };
    if (websocketMask) {
      module.exports.mask = function(source, mask, output, offset, length) {
        if (length < 24) _mask(source, mask, output, offset, length);
        else websocketMask(source, mask, output, offset, length);
      };
      module.exports.unmask = function(buffer, mask) {
        if (buffer.length < 24) _unmask(buffer, mask);
        else websocketUnmask(buffer, mask);
      };
    } else if (!process.env.WS_NO_BUFFER_UTIL) {
      try {
        const bufferUtil = __require("bufferutil");
        module.exports.mask = function(source, mask, output, offset, length) {
          if (length < 48) _mask(source, mask, output, offset, length);
          else bufferUtil.mask(source, mask, output, offset, length);
        };
        module.exports.unmask = function(buffer, mask) {
          if (buffer.length < 32) _unmask(buffer, mask);
          else bufferUtil.unmask(buffer, mask);
        };
      } catch (e) {
      }
    }
  }
});

// node_modules/ws/lib/limiter.js
var require_limiter = __commonJS({
  "node_modules/ws/lib/limiter.js"(exports, module) {
    "use strict";
    var kDone = /* @__PURE__ */ Symbol("kDone");
    var kRun = /* @__PURE__ */ Symbol("kRun");
    var Limiter = class {
      /**
       * Creates a new `Limiter`.
       *
       * @param {Number} [concurrency=Infinity] The maximum number of jobs allowed
       *     to run concurrently
       */
      constructor(concurrency) {
        this[kDone] = () => {
          this.pending--;
          this[kRun]();
        };
        this.concurrency = concurrency || Infinity;
        this.jobs = [];
        this.pending = 0;
      }
      /**
       * Adds a job to the queue.
       *
       * @param {Function} job The job to run
       * @public
       */
      add(job) {
        this.jobs.push(job);
        this[kRun]();
      }
      /**
       * Removes a job from the queue and runs it if possible.
       *
       * @private
       */
      [kRun]() {
        if (this.pending === this.concurrency) return;
        if (this.jobs.length) {
          const job = this.jobs.shift();
          this.pending++;
          job(this[kDone]);
        }
      }
    };
    module.exports = Limiter;
  }
});

// node_modules/ws/lib/permessage-deflate.js
var require_permessage_deflate = __commonJS({
  "node_modules/ws/lib/permessage-deflate.js"(exports, module) {
    "use strict";
    var zlib = __require("zlib");
    var bufferUtil = require_buffer_util();
    var Limiter = require_limiter();
    var { kStatusCode } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    var TRAILER = Buffer.from([0, 0, 255, 255]);
    var kPerMessageDeflate = /* @__PURE__ */ Symbol("permessage-deflate");
    var kTotalLength = /* @__PURE__ */ Symbol("total-length");
    var kCallback = /* @__PURE__ */ Symbol("callback");
    var kBuffers = /* @__PURE__ */ Symbol("buffers");
    var kError = /* @__PURE__ */ Symbol("error");
    var zlibLimiter;
    var PerMessageDeflate2 = class {
      /**
       * Creates a PerMessageDeflate instance.
       *
       * @param {Object} [options] Configuration options
       * @param {(Boolean|Number)} [options.clientMaxWindowBits] Advertise support
       *     for, or request, a custom client window size
       * @param {Boolean} [options.clientNoContextTakeover=false] Advertise/
       *     acknowledge disabling of client context takeover
       * @param {Number} [options.concurrencyLimit=10] The number of concurrent
       *     calls to zlib
       * @param {Boolean} [options.isServer=false] Create the instance in either
       *     server or client mode
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {(Boolean|Number)} [options.serverMaxWindowBits] Request/confirm the
       *     use of a custom server window size
       * @param {Boolean} [options.serverNoContextTakeover=false] Request/accept
       *     disabling of server context takeover
       * @param {Number} [options.threshold=1024] Size (in bytes) below which
       *     messages should not be compressed if context takeover is disabled
       * @param {Object} [options.zlibDeflateOptions] Options to pass to zlib on
       *     deflate
       * @param {Object} [options.zlibInflateOptions] Options to pass to zlib on
       *     inflate
       */
      constructor(options) {
        this._options = options || {};
        this._threshold = this._options.threshold !== void 0 ? this._options.threshold : 1024;
        this._maxPayload = this._options.maxPayload | 0;
        this._isServer = !!this._options.isServer;
        this._deflate = null;
        this._inflate = null;
        this.params = null;
        if (!zlibLimiter) {
          const concurrency = this._options.concurrencyLimit !== void 0 ? this._options.concurrencyLimit : 10;
          zlibLimiter = new Limiter(concurrency);
        }
      }
      /**
       * @type {String}
       */
      static get extensionName() {
        return "permessage-deflate";
      }
      /**
       * Create an extension negotiation offer.
       *
       * @return {Object} Extension parameters
       * @public
       */
      offer() {
        const params = {};
        if (this._options.serverNoContextTakeover) {
          params.server_no_context_takeover = true;
        }
        if (this._options.clientNoContextTakeover) {
          params.client_no_context_takeover = true;
        }
        if (this._options.serverMaxWindowBits) {
          params.server_max_window_bits = this._options.serverMaxWindowBits;
        }
        if (this._options.clientMaxWindowBits) {
          params.client_max_window_bits = this._options.clientMaxWindowBits;
        } else if (this._options.clientMaxWindowBits == null) {
          params.client_max_window_bits = true;
        }
        return params;
      }
      /**
       * Accept an extension negotiation offer/response.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Object} Accepted configuration
       * @public
       */
      accept(configurations) {
        configurations = this.normalizeParams(configurations);
        this.params = this._isServer ? this.acceptAsServer(configurations) : this.acceptAsClient(configurations);
        return this.params;
      }
      /**
       * Releases all resources used by the extension.
       *
       * @public
       */
      cleanup() {
        if (this._inflate) {
          this._inflate.close();
          this._inflate = null;
        }
        if (this._deflate) {
          const callback = this._deflate[kCallback];
          this._deflate.close();
          this._deflate = null;
          if (callback) {
            callback(
              new Error(
                "The deflate stream was closed while data was being processed"
              )
            );
          }
        }
      }
      /**
       *  Accept an extension negotiation offer.
       *
       * @param {Array} offers The extension negotiation offers
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsServer(offers) {
        const opts = this._options;
        const accepted = offers.find((params) => {
          if (opts.serverNoContextTakeover === false && params.server_no_context_takeover || params.server_max_window_bits && (opts.serverMaxWindowBits === false || typeof opts.serverMaxWindowBits === "number" && opts.serverMaxWindowBits > params.server_max_window_bits) || typeof opts.clientMaxWindowBits === "number" && (typeof params.client_max_window_bits === "number" ? opts.clientMaxWindowBits > params.client_max_window_bits : !params.client_max_window_bits)) {
            return false;
          }
          return true;
        });
        if (!accepted) {
          throw new Error("None of the extension offers can be accepted");
        }
        if (opts.serverNoContextTakeover) {
          accepted.server_no_context_takeover = true;
        }
        if (opts.clientNoContextTakeover) {
          accepted.client_no_context_takeover = true;
        }
        if (typeof opts.serverMaxWindowBits === "number") {
          accepted.server_max_window_bits = opts.serverMaxWindowBits;
        }
        if (typeof opts.clientMaxWindowBits === "number") {
          accepted.client_max_window_bits = opts.clientMaxWindowBits;
        } else if (accepted.client_max_window_bits === true || opts.clientMaxWindowBits === false) {
          delete accepted.client_max_window_bits;
        }
        return accepted;
      }
      /**
       * Accept the extension negotiation response.
       *
       * @param {Array} response The extension negotiation response
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsClient(response) {
        const params = response[0];
        if (this._options.clientNoContextTakeover === false && params.client_no_context_takeover) {
          throw new Error('Unexpected parameter "client_no_context_takeover"');
        }
        if (!params.client_max_window_bits) {
          if (typeof this._options.clientMaxWindowBits === "number") {
            params.client_max_window_bits = this._options.clientMaxWindowBits;
          }
        } else if (this._options.clientMaxWindowBits === false || typeof this._options.clientMaxWindowBits === "number" && params.client_max_window_bits > this._options.clientMaxWindowBits) {
          throw new Error(
            'Unexpected or invalid parameter "client_max_window_bits"'
          );
        }
        return params;
      }
      /**
       * Normalize parameters.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Array} The offers/response with normalized parameters
       * @private
       */
      normalizeParams(configurations) {
        configurations.forEach((params) => {
          Object.keys(params).forEach((key) => {
            let value = params[key];
            if (value.length > 1) {
              throw new Error(`Parameter "${key}" must have only a single value`);
            }
            value = value[0];
            if (key === "client_max_window_bits") {
              if (value !== true) {
                const num = +value;
                if (!Number.isInteger(num) || num < 8 || num > 15) {
                  throw new TypeError(
                    `Invalid value for parameter "${key}": ${value}`
                  );
                }
                value = num;
              } else if (!this._isServer) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else if (key === "server_max_window_bits") {
              const num = +value;
              if (!Number.isInteger(num) || num < 8 || num > 15) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
              value = num;
            } else if (key === "client_no_context_takeover" || key === "server_no_context_takeover") {
              if (value !== true) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else {
              throw new Error(`Unknown parameter "${key}"`);
            }
            params[key] = value;
          });
        });
        return configurations;
      }
      /**
       * Decompress data. Concurrency limited.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      decompress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._decompress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Compress data. Concurrency limited.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      compress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._compress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Decompress data.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _decompress(data, fin, callback) {
        const endpoint2 = this._isServer ? "client" : "server";
        if (!this._inflate) {
          const key = `${endpoint2}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._inflate = zlib.createInflateRaw({
            ...this._options.zlibInflateOptions,
            windowBits
          });
          this._inflate[kPerMessageDeflate] = this;
          this._inflate[kTotalLength] = 0;
          this._inflate[kBuffers] = [];
          this._inflate.on("error", inflateOnError);
          this._inflate.on("data", inflateOnData);
        }
        this._inflate[kCallback] = callback;
        this._inflate.write(data);
        if (fin) this._inflate.write(TRAILER);
        this._inflate.flush(() => {
          const err = this._inflate[kError];
          if (err) {
            this._inflate.close();
            this._inflate = null;
            callback(err);
            return;
          }
          const data2 = bufferUtil.concat(
            this._inflate[kBuffers],
            this._inflate[kTotalLength]
          );
          if (this._inflate._readableState.endEmitted) {
            this._inflate.close();
            this._inflate = null;
          } else {
            this._inflate[kTotalLength] = 0;
            this._inflate[kBuffers] = [];
            if (fin && this.params[`${endpoint2}_no_context_takeover`]) {
              this._inflate.reset();
            }
          }
          callback(null, data2);
        });
      }
      /**
       * Compress data.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _compress(data, fin, callback) {
        const endpoint2 = this._isServer ? "server" : "client";
        if (!this._deflate) {
          const key = `${endpoint2}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._deflate = zlib.createDeflateRaw({
            ...this._options.zlibDeflateOptions,
            windowBits
          });
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          this._deflate.on("data", deflateOnData);
        }
        this._deflate[kCallback] = callback;
        this._deflate.write(data);
        this._deflate.flush(zlib.Z_SYNC_FLUSH, () => {
          if (!this._deflate) {
            return;
          }
          let data2 = bufferUtil.concat(
            this._deflate[kBuffers],
            this._deflate[kTotalLength]
          );
          if (fin) {
            data2 = new FastBuffer(data2.buffer, data2.byteOffset, data2.length - 4);
          }
          this._deflate[kCallback] = null;
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          if (fin && this.params[`${endpoint2}_no_context_takeover`]) {
            this._deflate.reset();
          }
          callback(null, data2);
        });
      }
    };
    module.exports = PerMessageDeflate2;
    function deflateOnData(chunk) {
      this[kBuffers].push(chunk);
      this[kTotalLength] += chunk.length;
    }
    function inflateOnData(chunk) {
      this[kTotalLength] += chunk.length;
      if (this[kPerMessageDeflate]._maxPayload < 1 || this[kTotalLength] <= this[kPerMessageDeflate]._maxPayload) {
        this[kBuffers].push(chunk);
        return;
      }
      this[kError] = new RangeError("Max payload size exceeded");
      this[kError].code = "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
      this[kError][kStatusCode] = 1009;
      this.removeListener("data", inflateOnData);
      this.reset();
    }
    function inflateOnError(err) {
      this[kPerMessageDeflate]._inflate = null;
      if (this[kError]) {
        this[kCallback](this[kError]);
        return;
      }
      err[kStatusCode] = 1007;
      this[kCallback](err);
    }
  }
});

// node_modules/ws/lib/validation.js
var require_validation = __commonJS({
  "node_modules/ws/lib/validation.js"(exports, module) {
    "use strict";
    var { isUtf8 } = __require("buffer");
    var { hasBlob } = require_constants();
    var tokenChars = [
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 0 - 15
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 16 - 31
      0,
      1,
      0,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      1,
      1,
      0,
      1,
      1,
      0,
      // 32 - 47
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      // 48 - 63
      0,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 64 - 79
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      1,
      1,
      // 80 - 95
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 96 - 111
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      1,
      0,
      1,
      0
      // 112 - 127
    ];
    function isValidStatusCode(code) {
      return code >= 1e3 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006 || code >= 3e3 && code <= 4999;
    }
    function _isValidUTF8(buf) {
      const len = buf.length;
      let i = 0;
      while (i < len) {
        if ((buf[i] & 128) === 0) {
          i++;
        } else if ((buf[i] & 224) === 192) {
          if (i + 1 === len || (buf[i + 1] & 192) !== 128 || (buf[i] & 254) === 192) {
            return false;
          }
          i += 2;
        } else if ((buf[i] & 240) === 224) {
          if (i + 2 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || buf[i] === 224 && (buf[i + 1] & 224) === 128 || // Overlong
          buf[i] === 237 && (buf[i + 1] & 224) === 160) {
            return false;
          }
          i += 3;
        } else if ((buf[i] & 248) === 240) {
          if (i + 3 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || (buf[i + 3] & 192) !== 128 || buf[i] === 240 && (buf[i + 1] & 240) === 128 || // Overlong
          buf[i] === 244 && buf[i + 1] > 143 || buf[i] > 244) {
            return false;
          }
          i += 4;
        } else {
          return false;
        }
      }
      return true;
    }
    function isBlob(value) {
      return hasBlob && typeof value === "object" && typeof value.arrayBuffer === "function" && typeof value.type === "string" && typeof value.stream === "function" && (value[Symbol.toStringTag] === "Blob" || value[Symbol.toStringTag] === "File");
    }
    module.exports = {
      isBlob,
      isValidStatusCode,
      isValidUTF8: _isValidUTF8,
      tokenChars
    };
    if (isUtf8) {
      module.exports.isValidUTF8 = function(buf) {
        return buf.length < 24 ? _isValidUTF8(buf) : isUtf8(buf);
      };
    } else if (!process.env.WS_NO_UTF_8_VALIDATE) {
      try {
        const isValidUTF8 = __require("utf-8-validate");
        module.exports.isValidUTF8 = function(buf) {
          return buf.length < 32 ? _isValidUTF8(buf) : isValidUTF8(buf);
        };
      } catch (e) {
      }
    }
  }
});

// node_modules/ws/lib/receiver.js
var require_receiver = __commonJS({
  "node_modules/ws/lib/receiver.js"(exports, module) {
    "use strict";
    var { Writable } = __require("stream");
    var PerMessageDeflate2 = require_permessage_deflate();
    var {
      BINARY_TYPES,
      EMPTY_BUFFER,
      kStatusCode,
      kWebSocket
    } = require_constants();
    var { concat, toArrayBuffer, unmask } = require_buffer_util();
    var { isValidStatusCode, isValidUTF8 } = require_validation();
    var FastBuffer = Buffer[Symbol.species];
    var GET_INFO = 0;
    var GET_PAYLOAD_LENGTH_16 = 1;
    var GET_PAYLOAD_LENGTH_64 = 2;
    var GET_MASK = 3;
    var GET_DATA = 4;
    var INFLATING = 5;
    var DEFER_EVENT = 6;
    var Receiver2 = class extends Writable {
      /**
       * Creates a Receiver instance.
       *
       * @param {Object} [options] Options object
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {String} [options.binaryType=nodebuffer] The type for binary data
       * @param {Object} [options.extensions] An object containing the negotiated
       *     extensions
       * @param {Boolean} [options.isServer=false] Specifies whether to operate in
       *     client or server mode
       * @param {Number} [options.maxBufferedChunks=0] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=0] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       */
      constructor(options = {}) {
        super();
        this._allowSynchronousEvents = options.allowSynchronousEvents !== void 0 ? options.allowSynchronousEvents : true;
        this._binaryType = options.binaryType || BINARY_TYPES[0];
        this._extensions = options.extensions || {};
        this._isServer = !!options.isServer;
        this._maxBufferedChunks = options.maxBufferedChunks | 0;
        this._maxFragments = options.maxFragments | 0;
        this._maxPayload = options.maxPayload | 0;
        this._skipUTF8Validation = !!options.skipUTF8Validation;
        this[kWebSocket] = void 0;
        this._bufferedBytes = 0;
        this._buffers = [];
        this._compressed = false;
        this._payloadLength = 0;
        this._mask = void 0;
        this._fragmented = 0;
        this._masked = false;
        this._fin = false;
        this._opcode = 0;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._numFragments = 0;
        this._fragments = [];
        this._errored = false;
        this._loop = false;
        this._state = GET_INFO;
      }
      /**
       * Implements `Writable.prototype._write()`.
       *
       * @param {Buffer} chunk The chunk of data to write
       * @param {String} encoding The character encoding of `chunk`
       * @param {Function} cb Callback
       * @private
       */
      _write(chunk, encoding, cb) {
        if (this._opcode === 8 && this._state == GET_INFO) return cb();
        if (this._maxBufferedChunks > 0 && this._buffers.length >= this._maxBufferedChunks) {
          cb(
            this.createError(
              RangeError,
              "Too many buffered chunks",
              false,
              1008,
              "WS_ERR_TOO_MANY_BUFFERED_PARTS"
            )
          );
          return;
        }
        this._bufferedBytes += chunk.length;
        this._buffers.push(chunk);
        this.startLoop(cb);
      }
      /**
       * Consumes `n` bytes from the buffered data.
       *
       * @param {Number} n The number of bytes to consume
       * @return {Buffer} The consumed bytes
       * @private
       */
      consume(n) {
        this._bufferedBytes -= n;
        if (n === this._buffers[0].length) return this._buffers.shift();
        if (n < this._buffers[0].length) {
          const buf = this._buffers[0];
          this._buffers[0] = new FastBuffer(
            buf.buffer,
            buf.byteOffset + n,
            buf.length - n
          );
          return new FastBuffer(buf.buffer, buf.byteOffset, n);
        }
        const dst = Buffer.allocUnsafe(n);
        do {
          const buf = this._buffers[0];
          const offset = dst.length - n;
          if (n >= buf.length) {
            dst.set(this._buffers.shift(), offset);
          } else {
            dst.set(new Uint8Array(buf.buffer, buf.byteOffset, n), offset);
            this._buffers[0] = new FastBuffer(
              buf.buffer,
              buf.byteOffset + n,
              buf.length - n
            );
          }
          n -= buf.length;
        } while (n > 0);
        return dst;
      }
      /**
       * Starts the parsing loop.
       *
       * @param {Function} cb Callback
       * @private
       */
      startLoop(cb) {
        this._loop = true;
        do {
          switch (this._state) {
            case GET_INFO:
              this.getInfo(cb);
              break;
            case GET_PAYLOAD_LENGTH_16:
              this.getPayloadLength16(cb);
              break;
            case GET_PAYLOAD_LENGTH_64:
              this.getPayloadLength64(cb);
              break;
            case GET_MASK:
              this.getMask();
              break;
            case GET_DATA:
              this.getData(cb);
              break;
            case INFLATING:
            case DEFER_EVENT:
              this._loop = false;
              return;
          }
        } while (this._loop);
        if (!this._errored) cb();
      }
      /**
       * Reads the first two bytes of a frame.
       *
       * @param {Function} cb Callback
       * @private
       */
      getInfo(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        const buf = this.consume(2);
        if ((buf[0] & 48) !== 0) {
          const error = this.createError(
            RangeError,
            "RSV2 and RSV3 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_2_3"
          );
          cb(error);
          return;
        }
        const compressed = (buf[0] & 64) === 64;
        if (compressed && !this._extensions[PerMessageDeflate2.extensionName]) {
          const error = this.createError(
            RangeError,
            "RSV1 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_1"
          );
          cb(error);
          return;
        }
        this._fin = (buf[0] & 128) === 128;
        this._opcode = buf[0] & 15;
        this._payloadLength = buf[1] & 127;
        if (this._opcode === 0) {
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (!this._fragmented) {
            const error = this.createError(
              RangeError,
              "invalid opcode 0",
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._opcode = this._fragmented;
        } else if (this._opcode === 1 || this._opcode === 2) {
          if (this._fragmented) {
            const error = this.createError(
              RangeError,
              `invalid opcode ${this._opcode}`,
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._compressed = compressed;
        } else if (this._opcode > 7 && this._opcode < 11) {
          if (!this._fin) {
            const error = this.createError(
              RangeError,
              "FIN must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_FIN"
            );
            cb(error);
            return;
          }
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (this._payloadLength > 125 || this._opcode === 8 && this._payloadLength === 1) {
            const error = this.createError(
              RangeError,
              `invalid payload length ${this._payloadLength}`,
              true,
              1002,
              "WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH"
            );
            cb(error);
            return;
          }
        } else {
          const error = this.createError(
            RangeError,
            `invalid opcode ${this._opcode}`,
            true,
            1002,
            "WS_ERR_INVALID_OPCODE"
          );
          cb(error);
          return;
        }
        if (!this._fin && !this._fragmented) this._fragmented = this._opcode;
        this._masked = (buf[1] & 128) === 128;
        if (this._isServer) {
          if (!this._masked) {
            const error = this.createError(
              RangeError,
              "MASK must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_MASK"
            );
            cb(error);
            return;
          }
        } else if (this._masked) {
          const error = this.createError(
            RangeError,
            "MASK must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_MASK"
          );
          cb(error);
          return;
        }
        if (this._payloadLength === 126) this._state = GET_PAYLOAD_LENGTH_16;
        else if (this._payloadLength === 127) this._state = GET_PAYLOAD_LENGTH_64;
        else this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+16).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength16(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        this._payloadLength = this.consume(2).readUInt16BE(0);
        this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+64).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength64(cb) {
        if (this._bufferedBytes < 8) {
          this._loop = false;
          return;
        }
        const buf = this.consume(8);
        const num = buf.readUInt32BE(0);
        if (num > Math.pow(2, 53 - 32) - 1) {
          const error = this.createError(
            RangeError,
            "Unsupported WebSocket frame: payload length > 2^53 - 1",
            false,
            1009,
            "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH"
          );
          cb(error);
          return;
        }
        this._payloadLength = num * Math.pow(2, 32) + buf.readUInt32BE(4);
        this.haveLength(cb);
      }
      /**
       * Payload length has been read.
       *
       * @param {Function} cb Callback
       * @private
       */
      haveLength(cb) {
        if (this._payloadLength && this._opcode < 8) {
          this._totalPayloadLength += this._payloadLength;
          if (this._totalPayloadLength > this._maxPayload && this._maxPayload > 0) {
            const error = this.createError(
              RangeError,
              "Max payload size exceeded",
              false,
              1009,
              "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
            );
            cb(error);
            return;
          }
        }
        if (this._masked) this._state = GET_MASK;
        else this._state = GET_DATA;
      }
      /**
       * Reads mask bytes.
       *
       * @private
       */
      getMask() {
        if (this._bufferedBytes < 4) {
          this._loop = false;
          return;
        }
        this._mask = this.consume(4);
        this._state = GET_DATA;
      }
      /**
       * Reads data bytes.
       *
       * @param {Function} cb Callback
       * @private
       */
      getData(cb) {
        let data = EMPTY_BUFFER;
        if (this._payloadLength) {
          if (this._bufferedBytes < this._payloadLength) {
            this._loop = false;
            return;
          }
          data = this.consume(this._payloadLength);
          if (this._masked && (this._mask[0] | this._mask[1] | this._mask[2] | this._mask[3]) !== 0) {
            unmask(data, this._mask);
          }
        }
        if (this._opcode > 7) {
          this.controlMessage(data, cb);
          return;
        }
        if (this._maxFragments > 0 && ++this._numFragments > this._maxFragments) {
          const error = this.createError(
            RangeError,
            "Too many message fragments",
            false,
            1008,
            "WS_ERR_TOO_MANY_BUFFERED_PARTS"
          );
          cb(error);
          return;
        }
        if (this._compressed) {
          this._state = INFLATING;
          this.decompress(data, cb);
          return;
        }
        if (data.length) {
          this._messageLength = this._totalPayloadLength;
          this._fragments.push(data);
        }
        this.dataMessage(cb);
      }
      /**
       * Decompresses data.
       *
       * @param {Buffer} data Compressed data
       * @param {Function} cb Callback
       * @private
       */
      decompress(data, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        perMessageDeflate.decompress(data, this._fin, (err, buf) => {
          if (err) return cb(err);
          if (buf.length) {
            this._messageLength += buf.length;
            if (this._messageLength > this._maxPayload && this._maxPayload > 0) {
              const error = this.createError(
                RangeError,
                "Max payload size exceeded",
                false,
                1009,
                "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
              );
              cb(error);
              return;
            }
            this._fragments.push(buf);
          }
          this.dataMessage(cb);
          if (this._state === GET_INFO) this.startLoop(cb);
        });
      }
      /**
       * Handles a data message.
       *
       * @param {Function} cb Callback
       * @private
       */
      dataMessage(cb) {
        if (!this._fin) {
          this._state = GET_INFO;
          return;
        }
        const messageLength = this._messageLength;
        const fragments = this._fragments;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragmented = 0;
        this._numFragments = 0;
        this._fragments = [];
        if (this._opcode === 2) {
          let data;
          if (this._binaryType === "nodebuffer") {
            data = concat(fragments, messageLength);
          } else if (this._binaryType === "arraybuffer") {
            data = toArrayBuffer(concat(fragments, messageLength));
          } else if (this._binaryType === "blob") {
            data = new Blob(fragments);
          } else {
            data = fragments;
          }
          if (this._allowSynchronousEvents) {
            this.emit("message", data, true);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", data, true);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        } else {
          const buf = concat(fragments, messageLength);
          if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
            const error = this.createError(
              Error,
              "invalid UTF-8 sequence",
              true,
              1007,
              "WS_ERR_INVALID_UTF8"
            );
            cb(error);
            return;
          }
          if (this._state === INFLATING || this._allowSynchronousEvents) {
            this.emit("message", buf, false);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", buf, false);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        }
      }
      /**
       * Handles a control message.
       *
       * @param {Buffer} data Data to handle
       * @return {(Error|RangeError|undefined)} A possible error
       * @private
       */
      controlMessage(data, cb) {
        if (this._opcode === 8) {
          if (data.length === 0) {
            this._loop = false;
            this.emit("conclude", 1005, EMPTY_BUFFER);
            this.end();
          } else {
            const code = data.readUInt16BE(0);
            if (!isValidStatusCode(code)) {
              const error = this.createError(
                RangeError,
                `invalid status code ${code}`,
                true,
                1002,
                "WS_ERR_INVALID_CLOSE_CODE"
              );
              cb(error);
              return;
            }
            const buf = new FastBuffer(
              data.buffer,
              data.byteOffset + 2,
              data.length - 2
            );
            if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
              const error = this.createError(
                Error,
                "invalid UTF-8 sequence",
                true,
                1007,
                "WS_ERR_INVALID_UTF8"
              );
              cb(error);
              return;
            }
            this._loop = false;
            this.emit("conclude", code, buf);
            this.end();
          }
          this._state = GET_INFO;
          return;
        }
        if (this._allowSynchronousEvents) {
          this.emit(this._opcode === 9 ? "ping" : "pong", data);
          this._state = GET_INFO;
        } else {
          this._state = DEFER_EVENT;
          setImmediate(() => {
            this.emit(this._opcode === 9 ? "ping" : "pong", data);
            this._state = GET_INFO;
            this.startLoop(cb);
          });
        }
      }
      /**
       * Builds an error object.
       *
       * @param {function(new:Error|RangeError)} ErrorCtor The error constructor
       * @param {String} message The error message
       * @param {Boolean} prefix Specifies whether or not to add a default prefix to
       *     `message`
       * @param {Number} statusCode The status code
       * @param {String} errorCode The exposed error code
       * @return {(Error|RangeError)} The error
       * @private
       */
      createError(ErrorCtor, message, prefix, statusCode, errorCode) {
        this._loop = false;
        this._errored = true;
        const err = new ErrorCtor(
          prefix ? `Invalid WebSocket frame: ${message}` : message
        );
        Error.captureStackTrace(err, this.createError);
        err.code = errorCode;
        err[kStatusCode] = statusCode;
        return err;
      }
    };
    module.exports = Receiver2;
  }
});

// node_modules/ws/lib/sender.js
var require_sender = __commonJS({
  "node_modules/ws/lib/sender.js"(exports, module) {
    "use strict";
    var { Duplex } = __require("stream");
    var { randomFillSync } = __require("crypto");
    var {
      types: { isUint8Array }
    } = __require("util");
    var PerMessageDeflate2 = require_permessage_deflate();
    var { EMPTY_BUFFER, kWebSocket, NOOP } = require_constants();
    var { isBlob, isValidStatusCode } = require_validation();
    var { mask: applyMask, toBuffer } = require_buffer_util();
    var kByteLength = /* @__PURE__ */ Symbol("kByteLength");
    var maskBuffer = Buffer.alloc(4);
    var RANDOM_POOL_SIZE = 8 * 1024;
    var randomPool;
    var randomPoolPointer = RANDOM_POOL_SIZE;
    var DEFAULT = 0;
    var DEFLATING = 1;
    var GET_BLOB_DATA = 2;
    var Sender2 = class _Sender {
      /**
       * Creates a Sender instance.
       *
       * @param {Duplex} socket The connection socket
       * @param {Object} [extensions] An object containing the negotiated extensions
       * @param {Function} [generateMask] The function used to generate the masking
       *     key
       */
      constructor(socket, extensions, generateMask) {
        this._extensions = extensions || {};
        if (generateMask) {
          this._generateMask = generateMask;
          this._maskBuffer = Buffer.alloc(4);
        }
        this._socket = socket;
        this._firstFragment = true;
        this._compress = false;
        this._bufferedBytes = 0;
        this._queue = [];
        this._state = DEFAULT;
        this.onerror = NOOP;
        this[kWebSocket] = void 0;
      }
      /**
       * Frames a piece of data according to the HyBi WebSocket protocol.
       *
       * @param {(Buffer|String)} data The data to frame
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @return {(Buffer|String)[]} The framed data
       * @public
       */
      static frame(data, options) {
        let mask;
        let merge = false;
        let offset = 2;
        let skipMasking = false;
        if (options.mask) {
          mask = options.maskBuffer || maskBuffer;
          if (options.generateMask) {
            options.generateMask(mask);
          } else {
            if (randomPoolPointer === RANDOM_POOL_SIZE) {
              if (randomPool === void 0) {
                randomPool = Buffer.alloc(RANDOM_POOL_SIZE);
              }
              randomFillSync(randomPool, 0, RANDOM_POOL_SIZE);
              randomPoolPointer = 0;
            }
            mask[0] = randomPool[randomPoolPointer++];
            mask[1] = randomPool[randomPoolPointer++];
            mask[2] = randomPool[randomPoolPointer++];
            mask[3] = randomPool[randomPoolPointer++];
          }
          skipMasking = (mask[0] | mask[1] | mask[2] | mask[3]) === 0;
          offset = 6;
        }
        let dataLength;
        if (typeof data === "string") {
          if ((!options.mask || skipMasking) && options[kByteLength] !== void 0) {
            dataLength = options[kByteLength];
          } else {
            data = Buffer.from(data);
            dataLength = data.length;
          }
        } else {
          dataLength = data.length;
          merge = options.mask && options.readOnly && !skipMasking;
        }
        let payloadLength = dataLength;
        if (dataLength >= 65536) {
          offset += 8;
          payloadLength = 127;
        } else if (dataLength > 125) {
          offset += 2;
          payloadLength = 126;
        }
        const target = Buffer.allocUnsafe(merge ? dataLength + offset : offset);
        target[0] = options.fin ? options.opcode | 128 : options.opcode;
        if (options.rsv1) target[0] |= 64;
        target[1] = payloadLength;
        if (payloadLength === 126) {
          target.writeUInt16BE(dataLength, 2);
        } else if (payloadLength === 127) {
          target[2] = target[3] = 0;
          target.writeUIntBE(dataLength, 4, 6);
        }
        if (!options.mask) {
          return dataLength ? [target, data] : [target];
        }
        target[1] |= 128;
        target[offset - 4] = mask[0];
        target[offset - 3] = mask[1];
        target[offset - 2] = mask[2];
        target[offset - 1] = mask[3];
        if (!dataLength) return [target];
        if (skipMasking) return [target, data];
        if (merge) {
          applyMask(data, mask, target, offset, dataLength);
          return [target];
        }
        applyMask(data, mask, data, 0, dataLength);
        return [target, data];
      }
      /**
       * Sends a close message to the other peer.
       *
       * @param {Number} [code] The status code component of the body
       * @param {(String|Buffer)} [data] The message component of the body
       * @param {Boolean} [mask=false] Specifies whether or not to mask the message
       * @param {Function} [cb] Callback
       * @public
       */
      close(code, data, mask, cb) {
        let buf;
        if (code === void 0) {
          buf = EMPTY_BUFFER;
        } else if (typeof code !== "number" || !isValidStatusCode(code)) {
          throw new TypeError("First argument must be a valid error code number");
        } else if (data === void 0 || !data.length) {
          buf = Buffer.allocUnsafe(2);
          buf.writeUInt16BE(code, 0);
        } else {
          const length = Buffer.byteLength(data);
          if (length > 123) {
            throw new RangeError("The message must not be greater than 123 bytes");
          }
          buf = Buffer.allocUnsafe(2 + length);
          buf.writeUInt16BE(code, 0);
          if (typeof data === "string") {
            buf.write(data, 2);
          } else if (isUint8Array(data)) {
            buf.set(data, 2);
          } else {
            throw new TypeError("Second argument must be a string or a Uint8Array");
          }
        }
        const options = {
          [kByteLength]: buf.length,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 8,
          readOnly: false,
          rsv1: false
        };
        if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, buf, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(buf, options), cb);
        }
      }
      /**
       * Sends a ping message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      ping(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 9,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a pong message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      pong(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 10,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a data message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Object} options Options object
       * @param {Boolean} [options.binary=false] Specifies whether `data` is binary
       *     or text
       * @param {Boolean} [options.compress=false] Specifies whether or not to
       *     compress `data`
       * @param {Boolean} [options.fin=false] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Function} [cb] Callback
       * @public
       */
      send(data, options, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        let opcode = options.binary ? 2 : 1;
        let rsv1 = options.compress;
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (this._firstFragment) {
          this._firstFragment = false;
          if (rsv1 && perMessageDeflate && perMessageDeflate.params[perMessageDeflate._isServer ? "server_no_context_takeover" : "client_no_context_takeover"]) {
            rsv1 = byteLength >= perMessageDeflate._threshold;
          }
          this._compress = rsv1;
        } else {
          rsv1 = false;
          opcode = 0;
        }
        if (options.fin) this._firstFragment = true;
        const opts = {
          [kByteLength]: byteLength,
          fin: options.fin,
          generateMask: this._generateMask,
          mask: options.mask,
          maskBuffer: this._maskBuffer,
          opcode,
          readOnly,
          rsv1
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, this._compress, opts, cb]);
          } else {
            this.getBlobData(data, this._compress, opts, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, this._compress, opts, cb]);
        } else {
          this.dispatch(data, this._compress, opts, cb);
        }
      }
      /**
       * Gets the contents of a blob as binary data.
       *
       * @param {Blob} blob The blob
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     the data
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      getBlobData(blob, compress, options, cb) {
        this._bufferedBytes += options[kByteLength];
        this._state = GET_BLOB_DATA;
        blob.arrayBuffer().then((arrayBuffer) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while the blob was being read"
            );
            process.nextTick(callCallbacks, this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          const data = toBuffer(arrayBuffer);
          if (!compress) {
            this._state = DEFAULT;
            this.sendFrame(_Sender.frame(data, options), cb);
            this.dequeue();
          } else {
            this.dispatch(data, compress, options, cb);
          }
        }).catch((err) => {
          process.nextTick(onError, this, err, cb);
        });
      }
      /**
       * Dispatches a message.
       *
       * @param {(Buffer|String)} data The message to send
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     `data`
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      dispatch(data, compress, options, cb) {
        if (!compress) {
          this.sendFrame(_Sender.frame(data, options), cb);
          return;
        }
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        this._bufferedBytes += options[kByteLength];
        this._state = DEFLATING;
        perMessageDeflate.compress(data, options.fin, (_, buf) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while data was being compressed"
            );
            callCallbacks(this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          this._state = DEFAULT;
          options.readOnly = false;
          this.sendFrame(_Sender.frame(buf, options), cb);
          this.dequeue();
        });
      }
      /**
       * Executes queued send operations.
       *
       * @private
       */
      dequeue() {
        while (this._state === DEFAULT && this._queue.length) {
          const params = this._queue.shift();
          this._bufferedBytes -= params[3][kByteLength];
          Reflect.apply(params[0], this, params.slice(1));
        }
      }
      /**
       * Enqueues a send operation.
       *
       * @param {Array} params Send operation parameters.
       * @private
       */
      enqueue(params) {
        this._bufferedBytes += params[3][kByteLength];
        this._queue.push(params);
      }
      /**
       * Sends a frame.
       *
       * @param {(Buffer | String)[]} list The frame to send
       * @param {Function} [cb] Callback
       * @private
       */
      sendFrame(list, cb) {
        if (list.length === 2) {
          this._socket.cork();
          this._socket.write(list[0]);
          this._socket.write(list[1], cb);
          this._socket.uncork();
        } else {
          this._socket.write(list[0], cb);
        }
      }
    };
    module.exports = Sender2;
    function callCallbacks(sender, err, cb) {
      if (typeof cb === "function") cb(err);
      for (let i = 0; i < sender._queue.length; i++) {
        const params = sender._queue[i];
        const callback = params[params.length - 1];
        if (typeof callback === "function") callback(err);
      }
    }
    function onError(sender, err, cb) {
      callCallbacks(sender, err, cb);
      sender.onerror(err);
    }
  }
});

// node_modules/ws/lib/event-target.js
var require_event_target = __commonJS({
  "node_modules/ws/lib/event-target.js"(exports, module) {
    "use strict";
    var { kForOnEventAttribute, kListener } = require_constants();
    var kCode = /* @__PURE__ */ Symbol("kCode");
    var kData = /* @__PURE__ */ Symbol("kData");
    var kError = /* @__PURE__ */ Symbol("kError");
    var kMessage = /* @__PURE__ */ Symbol("kMessage");
    var kReason = /* @__PURE__ */ Symbol("kReason");
    var kTarget = /* @__PURE__ */ Symbol("kTarget");
    var kType = /* @__PURE__ */ Symbol("kType");
    var kWasClean = /* @__PURE__ */ Symbol("kWasClean");
    var Event = class {
      /**
       * Create a new `Event`.
       *
       * @param {String} type The name of the event
       * @throws {TypeError} If the `type` argument is not specified
       */
      constructor(type) {
        this[kTarget] = null;
        this[kType] = type;
      }
      /**
       * @type {*}
       */
      get target() {
        return this[kTarget];
      }
      /**
       * @type {String}
       */
      get type() {
        return this[kType];
      }
    };
    Object.defineProperty(Event.prototype, "target", { enumerable: true });
    Object.defineProperty(Event.prototype, "type", { enumerable: true });
    var CloseEvent = class extends Event {
      /**
       * Create a new `CloseEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {Number} [options.code=0] The status code explaining why the
       *     connection was closed
       * @param {String} [options.reason=''] A human-readable string explaining why
       *     the connection was closed
       * @param {Boolean} [options.wasClean=false] Indicates whether or not the
       *     connection was cleanly closed
       */
      constructor(type, options = {}) {
        super(type);
        this[kCode] = options.code === void 0 ? 0 : options.code;
        this[kReason] = options.reason === void 0 ? "" : options.reason;
        this[kWasClean] = options.wasClean === void 0 ? false : options.wasClean;
      }
      /**
       * @type {Number}
       */
      get code() {
        return this[kCode];
      }
      /**
       * @type {String}
       */
      get reason() {
        return this[kReason];
      }
      /**
       * @type {Boolean}
       */
      get wasClean() {
        return this[kWasClean];
      }
    };
    Object.defineProperty(CloseEvent.prototype, "code", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "reason", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "wasClean", { enumerable: true });
    var ErrorEvent = class extends Event {
      /**
       * Create a new `ErrorEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.error=null] The error that generated this event
       * @param {String} [options.message=''] The error message
       */
      constructor(type, options = {}) {
        super(type);
        this[kError] = options.error === void 0 ? null : options.error;
        this[kMessage] = options.message === void 0 ? "" : options.message;
      }
      /**
       * @type {*}
       */
      get error() {
        return this[kError];
      }
      /**
       * @type {String}
       */
      get message() {
        return this[kMessage];
      }
    };
    Object.defineProperty(ErrorEvent.prototype, "error", { enumerable: true });
    Object.defineProperty(ErrorEvent.prototype, "message", { enumerable: true });
    var MessageEvent = class extends Event {
      /**
       * Create a new `MessageEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.data=null] The message content
       */
      constructor(type, options = {}) {
        super(type);
        this[kData] = options.data === void 0 ? null : options.data;
      }
      /**
       * @type {*}
       */
      get data() {
        return this[kData];
      }
    };
    Object.defineProperty(MessageEvent.prototype, "data", { enumerable: true });
    var EventTarget = {
      /**
       * Register an event listener.
       *
       * @param {String} type A string representing the event type to listen for
       * @param {(Function|Object)} handler The listener to add
       * @param {Object} [options] An options object specifies characteristics about
       *     the event listener
       * @param {Boolean} [options.once=false] A `Boolean` indicating that the
       *     listener should be invoked at most once after being added. If `true`,
       *     the listener would be automatically removed when invoked.
       * @public
       */
      addEventListener(type, handler, options = {}) {
        for (const listener of this.listeners(type)) {
          if (!options[kForOnEventAttribute] && listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            return;
          }
        }
        let wrapper;
        if (type === "message") {
          wrapper = function onMessage(data, isBinary) {
            const event = new MessageEvent("message", {
              data: isBinary ? data : data.toString()
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "close") {
          wrapper = function onClose(code, message) {
            const event = new CloseEvent("close", {
              code,
              reason: message.toString(),
              wasClean: this._closeFrameReceived && this._closeFrameSent
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "error") {
          wrapper = function onError(error) {
            const event = new ErrorEvent("error", {
              error,
              message: error.message
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "open") {
          wrapper = function onOpen() {
            const event = new Event("open");
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else {
          return;
        }
        wrapper[kForOnEventAttribute] = !!options[kForOnEventAttribute];
        wrapper[kListener] = handler;
        if (options.once) {
          this.once(type, wrapper);
        } else {
          this.on(type, wrapper);
        }
      },
      /**
       * Remove an event listener.
       *
       * @param {String} type A string representing the event type to remove
       * @param {(Function|Object)} handler The listener to remove
       * @public
       */
      removeEventListener(type, handler) {
        for (const listener of this.listeners(type)) {
          if (listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            this.removeListener(type, listener);
            break;
          }
        }
      }
    };
    module.exports = {
      CloseEvent,
      ErrorEvent,
      Event,
      EventTarget,
      MessageEvent
    };
    function callListener(listener, thisArg, event) {
      if (typeof listener === "object" && listener.handleEvent) {
        listener.handleEvent.call(listener, event);
      } else {
        listener.call(thisArg, event);
      }
    }
  }
});

// node_modules/ws/lib/extension.js
var require_extension = __commonJS({
  "node_modules/ws/lib/extension.js"(exports, module) {
    "use strict";
    var { tokenChars } = require_validation();
    function push(dest, name, elem) {
      if (dest[name] === void 0) dest[name] = [elem];
      else dest[name].push(elem);
    }
    function parse2(header) {
      const offers = /* @__PURE__ */ Object.create(null);
      let params = /* @__PURE__ */ Object.create(null);
      let mustUnescape = false;
      let isEscaping = false;
      let inQuotes = false;
      let extensionName;
      let paramName;
      let start = -1;
      let code = -1;
      let end = -1;
      let i = 0;
      for (; i < header.length; i++) {
        code = header.charCodeAt(i);
        if (extensionName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (i !== 0 && (code === 32 || code === 9)) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            const name = header.slice(start, end);
            if (code === 44) {
              push(offers, name, params);
              params = /* @__PURE__ */ Object.create(null);
            } else {
              extensionName = name;
            }
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else if (paramName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (code === 32 || code === 9) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            push(params, header.slice(start, end), true);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            start = end = -1;
          } else if (code === 61 && start !== -1 && end === -1) {
            paramName = header.slice(start, i);
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else {
          if (isEscaping) {
            if (tokenChars[code] !== 1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (start === -1) start = i;
            else if (!mustUnescape) mustUnescape = true;
            isEscaping = false;
          } else if (inQuotes) {
            if (tokenChars[code] === 1) {
              if (start === -1) start = i;
            } else if (code === 34 && start !== -1) {
              inQuotes = false;
              end = i;
            } else if (code === 92) {
              isEscaping = true;
            } else {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
          } else if (code === 34 && header.charCodeAt(i - 1) === 61) {
            inQuotes = true;
          } else if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (start !== -1 && (code === 32 || code === 9)) {
            if (end === -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            let value = header.slice(start, end);
            if (mustUnescape) {
              value = value.replace(/\\/g, "");
              mustUnescape = false;
            }
            push(params, paramName, value);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            paramName = void 0;
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        }
      }
      if (start === -1 || inQuotes || code === 32 || code === 9) {
        throw new SyntaxError("Unexpected end of input");
      }
      if (end === -1) end = i;
      const token = header.slice(start, end);
      if (extensionName === void 0) {
        push(offers, token, params);
      } else {
        if (paramName === void 0) {
          push(params, token, true);
        } else if (mustUnescape) {
          push(params, paramName, token.replace(/\\/g, ""));
        } else {
          push(params, paramName, token);
        }
        push(offers, extensionName, params);
      }
      return offers;
    }
    function format(extensions) {
      return Object.keys(extensions).map((extension2) => {
        let configurations = extensions[extension2];
        if (!Array.isArray(configurations)) configurations = [configurations];
        return configurations.map((params) => {
          return [extension2].concat(
            Object.keys(params).map((k) => {
              let values = params[k];
              if (!Array.isArray(values)) values = [values];
              return values.map((v) => v === true ? k : `${k}=${v}`).join("; ");
            })
          ).join("; ");
        }).join(", ");
      }).join(", ");
    }
    module.exports = { format, parse: parse2 };
  }
});

// node_modules/ws/lib/websocket.js
var require_websocket = __commonJS({
  "node_modules/ws/lib/websocket.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events");
    var https = __require("https");
    var http = __require("http");
    var net = __require("net");
    var tls = __require("tls");
    var { randomBytes, createHash: createHash5 } = __require("crypto");
    var { Duplex, Readable } = __require("stream");
    var { URL: URL2 } = __require("url");
    var PerMessageDeflate2 = require_permessage_deflate();
    var Receiver2 = require_receiver();
    var Sender2 = require_sender();
    var { isBlob } = require_validation();
    var {
      BINARY_TYPES,
      CLOSE_TIMEOUT,
      EMPTY_BUFFER,
      GUID,
      kForOnEventAttribute,
      kListener,
      kStatusCode,
      kWebSocket,
      NOOP
    } = require_constants();
    var {
      EventTarget: { addEventListener, removeEventListener }
    } = require_event_target();
    var { format, parse: parse2 } = require_extension();
    var { toBuffer } = require_buffer_util();
    var kAborted = /* @__PURE__ */ Symbol("kAborted");
    var protocolVersions = [8, 13];
    var readyStates = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
    var subprotocolRegex = /^[!#$%&'*+\-.0-9A-Z^_`|a-z~]+$/;
    var WebSocket2 = class _WebSocket extends EventEmitter {
      /**
       * Create a new `WebSocket`.
       *
       * @param {(String|URL)} address The URL to which to connect
       * @param {(String|String[])} [protocols] The subprotocols
       * @param {Object} [options] Connection options
       */
      constructor(address, protocols, options) {
        super();
        this._binaryType = BINARY_TYPES[0];
        this._closeCode = 1006;
        this._closeFrameReceived = false;
        this._closeFrameSent = false;
        this._closeMessage = EMPTY_BUFFER;
        this._closeTimer = null;
        this._errorEmitted = false;
        this._extensions = {};
        this._paused = false;
        this._protocol = "";
        this._readyState = _WebSocket.CONNECTING;
        this._receiver = null;
        this._sender = null;
        this._socket = null;
        if (address !== null) {
          this._bufferedAmount = 0;
          this._isServer = false;
          this._redirects = 0;
          if (protocols === void 0) {
            if (!options || options.protocols === void 0) {
              protocols = [];
            } else if (Array.isArray(options.protocols)) {
              protocols = options.protocols;
            } else {
              protocols = [options.protocols];
            }
          } else if (!Array.isArray(protocols)) {
            if (typeof protocols === "object" && protocols !== null) {
              options = protocols;
              if (options.protocols === void 0) {
                protocols = [];
              } else if (Array.isArray(options.protocols)) {
                protocols = options.protocols;
              } else {
                protocols = [options.protocols];
              }
            } else {
              protocols = [protocols];
            }
          }
          initAsClient(this, address, protocols, options);
        } else {
          this._autoPong = options.autoPong;
          this._closeTimeout = options.closeTimeout;
          this._isServer = true;
        }
      }
      /**
       * For historical reasons, the custom "nodebuffer" type is used by the default
       * instead of "blob".
       *
       * @type {String}
       */
      get binaryType() {
        return this._binaryType;
      }
      set binaryType(type) {
        if (!BINARY_TYPES.includes(type)) return;
        this._binaryType = type;
        if (this._receiver) this._receiver._binaryType = type;
      }
      /**
       * @type {Number}
       */
      get bufferedAmount() {
        if (!this._socket) return this._bufferedAmount;
        return this._socket._writableState.length + this._sender._bufferedBytes;
      }
      /**
       * @type {String}
       */
      get extensions() {
        return Object.keys(this._extensions).join();
      }
      /**
       * @type {Boolean}
       */
      get isPaused() {
        return this._paused;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onclose() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onerror() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onopen() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onmessage() {
        return null;
      }
      /**
       * @type {String}
       */
      get protocol() {
        return this._protocol;
      }
      /**
       * @type {Number}
       */
      get readyState() {
        return this._readyState;
      }
      /**
       * @type {String}
       */
      get url() {
        return this._url;
      }
      /**
       * Set up the socket and the internal resources.
       *
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Object} options Options object
       * @param {Boolean} [options.allowSynchronousEvents=false] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Number} [options.maxBufferedChunks=0] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=0] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=0] The maximum allowed message size
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @private
       */
      setSocket(socket, head, options) {
        const receiver = new Receiver2({
          allowSynchronousEvents: options.allowSynchronousEvents,
          binaryType: this.binaryType,
          extensions: this._extensions,
          isServer: this._isServer,
          maxBufferedChunks: options.maxBufferedChunks,
          maxFragments: options.maxFragments,
          maxPayload: options.maxPayload,
          skipUTF8Validation: options.skipUTF8Validation
        });
        const sender = new Sender2(socket, this._extensions, options.generateMask);
        this._receiver = receiver;
        this._sender = sender;
        this._socket = socket;
        receiver[kWebSocket] = this;
        sender[kWebSocket] = this;
        socket[kWebSocket] = this;
        receiver.on("conclude", receiverOnConclude);
        receiver.on("drain", receiverOnDrain);
        receiver.on("error", receiverOnError);
        receiver.on("message", receiverOnMessage);
        receiver.on("ping", receiverOnPing);
        receiver.on("pong", receiverOnPong);
        sender.onerror = senderOnError;
        if (socket.setTimeout) socket.setTimeout(0);
        if (socket.setNoDelay) socket.setNoDelay();
        if (head.length > 0) socket.unshift(head);
        socket.on("close", socketOnClose);
        socket.on("data", socketOnData);
        socket.on("end", socketOnEnd);
        socket.on("error", socketOnError);
        this._readyState = _WebSocket.OPEN;
        this.emit("open");
      }
      /**
       * Emit the `'close'` event.
       *
       * @private
       */
      emitClose() {
        if (!this._socket) {
          this._readyState = _WebSocket.CLOSED;
          this.emit("close", this._closeCode, this._closeMessage);
          return;
        }
        if (this._extensions[PerMessageDeflate2.extensionName]) {
          this._extensions[PerMessageDeflate2.extensionName].cleanup();
        }
        this._receiver.removeAllListeners();
        this._readyState = _WebSocket.CLOSED;
        this.emit("close", this._closeCode, this._closeMessage);
      }
      /**
       * Start a closing handshake.
       *
       *          +----------+   +-----------+   +----------+
       *     - - -|ws.close()|-->|close frame|-->|ws.close()|- - -
       *    |     +----------+   +-----------+   +----------+     |
       *          +----------+   +-----------+         |
       * CLOSING  |ws.close()|<--|close frame|<--+-----+       CLOSING
       *          +----------+   +-----------+   |
       *    |           |                        |   +---+        |
       *                +------------------------+-->|fin| - - - -
       *    |         +---+                      |   +---+
       *     - - - - -|fin|<---------------------+
       *              +---+
       *
       * @param {Number} [code] Status code explaining why the connection is closing
       * @param {(String|Buffer)} [data] The reason why the connection is
       *     closing
       * @public
       */
      close(code, data) {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this.readyState === _WebSocket.CLOSING) {
          if (this._closeFrameSent && (this._closeFrameReceived || this._receiver._writableState.errorEmitted)) {
            this._socket.end();
          }
          return;
        }
        this._sender.close(code, data, !this._isServer, (err) => {
          if (err) return;
          this._closeFrameSent = true;
          if (this._closeFrameReceived || this._receiver._writableState.errorEmitted) {
            this._socket.end();
          }
        });
        this._readyState = _WebSocket.CLOSING;
        setCloseTimer(this);
      }
      /**
       * Pause the socket.
       *
       * @public
       */
      pause() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = true;
        this._socket.pause();
      }
      /**
       * Send a ping.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the ping is sent
       * @public
       */
      ping(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.ping(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Send a pong.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the pong is sent
       * @public
       */
      pong(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.pong(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Resume the socket.
       *
       * @public
       */
      resume() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = false;
        if (!this._receiver._writableState.needDrain) this._socket.resume();
      }
      /**
       * Send a data message.
       *
       * @param {*} data The message to send
       * @param {Object} [options] Options object
       * @param {Boolean} [options.binary] Specifies whether `data` is binary or
       *     text
       * @param {Boolean} [options.compress] Specifies whether or not to compress
       *     `data`
       * @param {Boolean} [options.fin=true] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when data is written out
       * @public
       */
      send(data, options, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof options === "function") {
          cb = options;
          options = {};
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        const opts = {
          binary: typeof data !== "string",
          mask: !this._isServer,
          compress: true,
          fin: true,
          ...options
        };
        if (!this._extensions[PerMessageDeflate2.extensionName]) {
          opts.compress = false;
        }
        this._sender.send(data || EMPTY_BUFFER, opts, cb);
      }
      /**
       * Forcibly close the connection.
       *
       * @public
       */
      terminate() {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this._socket) {
          this._readyState = _WebSocket.CLOSING;
          this._socket.destroy();
        }
      }
    };
    Object.defineProperty(WebSocket2, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2.prototype, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2.prototype, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    [
      "binaryType",
      "bufferedAmount",
      "extensions",
      "isPaused",
      "protocol",
      "readyState",
      "url"
    ].forEach((property) => {
      Object.defineProperty(WebSocket2.prototype, property, { enumerable: true });
    });
    ["open", "error", "close", "message"].forEach((method) => {
      Object.defineProperty(WebSocket2.prototype, `on${method}`, {
        enumerable: true,
        get() {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) return listener[kListener];
          }
          return null;
        },
        set(handler) {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) {
              this.removeListener(method, listener);
              break;
            }
          }
          if (typeof handler !== "function") return;
          this.addEventListener(method, handler, {
            [kForOnEventAttribute]: true
          });
        }
      });
    });
    WebSocket2.prototype.addEventListener = addEventListener;
    WebSocket2.prototype.removeEventListener = removeEventListener;
    module.exports = WebSocket2;
    function initAsClient(websocket, address, protocols, options) {
      const opts = {
        allowSynchronousEvents: true,
        autoPong: true,
        closeTimeout: CLOSE_TIMEOUT,
        protocolVersion: protocolVersions[1],
        maxBufferedChunks: 256 * 1024,
        maxFragments: 16 * 1024,
        maxPayload: 100 * 1024 * 1024,
        skipUTF8Validation: false,
        perMessageDeflate: true,
        followRedirects: false,
        maxRedirects: 10,
        ...options,
        socketPath: void 0,
        hostname: void 0,
        protocol: void 0,
        protocols: void 0,
        timeout: void 0,
        method: "GET",
        host: void 0,
        path: void 0,
        port: void 0
      };
      websocket._autoPong = opts.autoPong;
      websocket._closeTimeout = opts.closeTimeout;
      if (!protocolVersions.includes(opts.protocolVersion)) {
        throw new RangeError(
          `Unsupported protocol version: ${opts.protocolVersion} (supported versions: ${protocolVersions.join(", ")})`
        );
      }
      let parsedUrl;
      if (address instanceof URL2) {
        parsedUrl = address;
      } else {
        try {
          parsedUrl = new URL2(address);
        } catch {
          throw new SyntaxError(`Invalid URL: ${address}`);
        }
      }
      if (parsedUrl.protocol === "http:") {
        parsedUrl.protocol = "ws:";
      } else if (parsedUrl.protocol === "https:") {
        parsedUrl.protocol = "wss:";
      }
      websocket._url = parsedUrl.href;
      const isSecure = parsedUrl.protocol === "wss:";
      const isIpcUrl = parsedUrl.protocol === "ws+unix:";
      let invalidUrlMessage;
      if (parsedUrl.protocol !== "ws:" && !isSecure && !isIpcUrl) {
        invalidUrlMessage = `The URL's protocol must be one of "ws:", "wss:", "http:", "https:", or "ws+unix:"`;
      } else if (isIpcUrl && !parsedUrl.pathname) {
        invalidUrlMessage = "The URL's pathname is empty";
      } else if (parsedUrl.hash) {
        invalidUrlMessage = "The URL contains a fragment identifier";
      }
      if (invalidUrlMessage) {
        const err = new SyntaxError(invalidUrlMessage);
        if (websocket._redirects === 0) {
          throw err;
        } else {
          emitErrorAndClose(websocket, err);
          return;
        }
      }
      const defaultPort = isSecure ? 443 : 80;
      const key = randomBytes(16).toString("base64");
      const request = isSecure ? https.request : http.request;
      const protocolSet = /* @__PURE__ */ new Set();
      let perMessageDeflate;
      opts.createConnection = opts.createConnection || (isSecure ? tlsConnect : netConnect);
      opts.defaultPort = opts.defaultPort || defaultPort;
      opts.port = parsedUrl.port || defaultPort;
      opts.host = parsedUrl.hostname.startsWith("[") ? parsedUrl.hostname.slice(1, -1) : parsedUrl.hostname;
      opts.headers = {
        ...opts.headers,
        "Sec-WebSocket-Version": opts.protocolVersion,
        "Sec-WebSocket-Key": key,
        Connection: "Upgrade",
        Upgrade: "websocket"
      };
      opts.path = parsedUrl.pathname + parsedUrl.search;
      opts.timeout = opts.handshakeTimeout;
      if (opts.perMessageDeflate) {
        perMessageDeflate = new PerMessageDeflate2({
          ...opts.perMessageDeflate,
          isServer: false,
          maxPayload: opts.maxPayload
        });
        opts.headers["Sec-WebSocket-Extensions"] = format({
          [PerMessageDeflate2.extensionName]: perMessageDeflate.offer()
        });
      }
      if (protocols.length) {
        for (const protocol of protocols) {
          if (typeof protocol !== "string" || !subprotocolRegex.test(protocol) || protocolSet.has(protocol)) {
            throw new SyntaxError(
              "An invalid or duplicated subprotocol was specified"
            );
          }
          protocolSet.add(protocol);
        }
        opts.headers["Sec-WebSocket-Protocol"] = protocols.join(",");
      }
      if (opts.origin) {
        if (opts.protocolVersion < 13) {
          opts.headers["Sec-WebSocket-Origin"] = opts.origin;
        } else {
          opts.headers.Origin = opts.origin;
        }
      }
      if (parsedUrl.username || parsedUrl.password) {
        opts.auth = `${parsedUrl.username}:${parsedUrl.password}`;
      }
      if (isIpcUrl) {
        const i = opts.path.indexOf(":");
        if (i === -1) {
          opts.socketPath = opts.path;
          opts.path = "";
        } else {
          opts.socketPath = opts.path.slice(0, i);
          opts.path = opts.path.slice(i + 1);
        }
      }
      let req;
      if (opts.followRedirects) {
        if (websocket._redirects === 0) {
          websocket._originalIpc = isIpcUrl;
          websocket._originalSecure = isSecure;
          websocket._originalHostOrSocketPath = isIpcUrl ? opts.socketPath : parsedUrl.host;
          const headers = options && options.headers;
          options = { ...options, headers: {} };
          if (headers) {
            for (const [key2, value] of Object.entries(headers)) {
              options.headers[key2.toLowerCase()] = value;
            }
          }
        } else if (websocket.listenerCount("redirect") === 0) {
          const isSameHost = isIpcUrl ? websocket._originalIpc ? opts.socketPath === websocket._originalHostOrSocketPath : false : websocket._originalIpc ? false : parsedUrl.host === websocket._originalHostOrSocketPath;
          if (!isSameHost || websocket._originalSecure && !isSecure) {
            delete opts.headers.authorization;
            delete opts.headers.cookie;
            if (!isSameHost) delete opts.headers.host;
            opts.auth = void 0;
          }
        }
        if (opts.auth && !options.headers.authorization) {
          options.headers.authorization = "Basic " + Buffer.from(opts.auth).toString("base64");
        }
        req = websocket._req = request(opts);
        if (websocket._redirects) {
          websocket.emit("redirect", websocket.url, req);
        }
      } else {
        req = websocket._req = request(opts);
      }
      if (opts.timeout) {
        req.on("timeout", () => {
          abortHandshake(websocket, req, "Opening handshake has timed out");
        });
      }
      req.on("error", (err) => {
        if (req === null || req[kAborted]) return;
        req = websocket._req = null;
        emitErrorAndClose(websocket, err);
      });
      req.on("response", (res) => {
        const location = res.headers.location;
        const statusCode = res.statusCode;
        if (location && opts.followRedirects && statusCode >= 300 && statusCode < 400) {
          if (++websocket._redirects > opts.maxRedirects) {
            abortHandshake(websocket, req, "Maximum redirects exceeded");
            return;
          }
          req.abort();
          let addr;
          try {
            addr = new URL2(location, address);
          } catch (e) {
            const err = new SyntaxError(`Invalid URL: ${location}`);
            emitErrorAndClose(websocket, err);
            return;
          }
          initAsClient(websocket, addr, protocols, options);
        } else if (!websocket.emit("unexpected-response", req, res)) {
          abortHandshake(
            websocket,
            req,
            `Unexpected server response: ${res.statusCode}`
          );
        }
      });
      req.on("upgrade", (res, socket, head) => {
        websocket.emit("upgrade", res);
        if (websocket.readyState !== WebSocket2.CONNECTING) return;
        req = websocket._req = null;
        const upgrade = res.headers.upgrade;
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          abortHandshake(websocket, socket, "Invalid Upgrade header");
          return;
        }
        const digest = createHash5("sha1").update(key + GUID).digest("base64");
        if (res.headers["sec-websocket-accept"] !== digest) {
          abortHandshake(websocket, socket, "Invalid Sec-WebSocket-Accept header");
          return;
        }
        const serverProt = res.headers["sec-websocket-protocol"];
        let protError;
        if (serverProt !== void 0) {
          if (!protocolSet.size) {
            protError = "Server sent a subprotocol but none was requested";
          } else if (!protocolSet.has(serverProt)) {
            protError = "Server sent an invalid subprotocol";
          }
        } else if (protocolSet.size) {
          protError = "Server sent no subprotocol";
        }
        if (protError) {
          abortHandshake(websocket, socket, protError);
          return;
        }
        if (serverProt) websocket._protocol = serverProt;
        const secWebSocketExtensions = res.headers["sec-websocket-extensions"];
        if (secWebSocketExtensions !== void 0) {
          if (!perMessageDeflate) {
            const message = "Server sent a Sec-WebSocket-Extensions header but no extension was requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          let extensions;
          try {
            extensions = parse2(secWebSocketExtensions);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          const extensionNames = Object.keys(extensions);
          if (extensionNames.length !== 1 || extensionNames[0] !== PerMessageDeflate2.extensionName) {
            const message = "Server indicated an extension that was not requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          try {
            perMessageDeflate.accept(extensions[PerMessageDeflate2.extensionName]);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          websocket._extensions[PerMessageDeflate2.extensionName] = perMessageDeflate;
        }
        websocket.setSocket(socket, head, {
          allowSynchronousEvents: opts.allowSynchronousEvents,
          generateMask: opts.generateMask,
          maxBufferedChunks: opts.maxBufferedChunks,
          maxFragments: opts.maxFragments,
          maxPayload: opts.maxPayload,
          skipUTF8Validation: opts.skipUTF8Validation
        });
      });
      if (opts.finishRequest) {
        opts.finishRequest(req, websocket);
      } else {
        req.end();
      }
    }
    function emitErrorAndClose(websocket, err) {
      websocket._readyState = WebSocket2.CLOSING;
      websocket._errorEmitted = true;
      websocket.emit("error", err);
      websocket.emitClose();
    }
    function netConnect(options) {
      options.path = options.socketPath;
      return net.connect(options);
    }
    function tlsConnect(options) {
      options.path = void 0;
      if (!options.servername && options.servername !== "") {
        options.servername = net.isIP(options.host) ? "" : options.host;
      }
      return tls.connect(options);
    }
    function abortHandshake(websocket, stream, message) {
      websocket._readyState = WebSocket2.CLOSING;
      const err = new Error(message);
      Error.captureStackTrace(err, abortHandshake);
      if (stream.setHeader) {
        stream[kAborted] = true;
        stream.abort();
        if (stream.socket && !stream.socket.destroyed) {
          stream.socket.destroy();
        }
        process.nextTick(emitErrorAndClose, websocket, err);
      } else {
        stream.destroy(err);
        stream.once("error", websocket.emit.bind(websocket, "error"));
        stream.once("close", websocket.emitClose.bind(websocket));
      }
    }
    function sendAfterClose(websocket, data, cb) {
      if (data) {
        const length = isBlob(data) ? data.size : toBuffer(data).length;
        if (websocket._socket) websocket._sender._bufferedBytes += length;
        else websocket._bufferedAmount += length;
      }
      if (cb) {
        const err = new Error(
          `WebSocket is not open: readyState ${websocket.readyState} (${readyStates[websocket.readyState]})`
        );
        process.nextTick(cb, err);
      }
    }
    function receiverOnConclude(code, reason) {
      const websocket = this[kWebSocket];
      websocket._closeFrameReceived = true;
      websocket._closeMessage = reason;
      websocket._closeCode = code;
      if (websocket._socket[kWebSocket] === void 0) return;
      websocket._socket.removeListener("data", socketOnData);
      process.nextTick(resume, websocket._socket);
      if (code === 1005) websocket.close();
      else websocket.close(code, reason);
    }
    function receiverOnDrain() {
      const websocket = this[kWebSocket];
      if (!websocket.isPaused) websocket._socket.resume();
    }
    function receiverOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket._socket[kWebSocket] !== void 0) {
        websocket._socket.removeListener("data", socketOnData);
        process.nextTick(resume, websocket._socket);
        websocket.close(err[kStatusCode]);
      }
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function receiverOnFinish() {
      this[kWebSocket].emitClose();
    }
    function receiverOnMessage(data, isBinary) {
      this[kWebSocket].emit("message", data, isBinary);
    }
    function receiverOnPing(data) {
      const websocket = this[kWebSocket];
      if (websocket._autoPong) websocket.pong(data, !this._isServer, NOOP);
      websocket.emit("ping", data);
    }
    function receiverOnPong(data) {
      this[kWebSocket].emit("pong", data);
    }
    function resume(stream) {
      stream.resume();
    }
    function senderOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket.readyState === WebSocket2.CLOSED) return;
      if (websocket.readyState === WebSocket2.OPEN) {
        websocket._readyState = WebSocket2.CLOSING;
        setCloseTimer(websocket);
      }
      this._socket.end();
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function setCloseTimer(websocket) {
      websocket._closeTimer = setTimeout(
        websocket._socket.destroy.bind(websocket._socket),
        websocket._closeTimeout
      );
    }
    function socketOnClose() {
      const websocket = this[kWebSocket];
      this.removeListener("close", socketOnClose);
      this.removeListener("data", socketOnData);
      this.removeListener("end", socketOnEnd);
      websocket._readyState = WebSocket2.CLOSING;
      if (!this._readableState.endEmitted && !websocket._closeFrameReceived && !websocket._receiver._writableState.errorEmitted && this._readableState.length !== 0) {
        const chunk = this.read(this._readableState.length);
        websocket._receiver.write(chunk);
      }
      websocket._receiver.end();
      this[kWebSocket] = void 0;
      clearTimeout(websocket._closeTimer);
      if (websocket._receiver._writableState.finished || websocket._receiver._writableState.errorEmitted) {
        websocket.emitClose();
      } else {
        websocket._receiver.on("error", receiverOnFinish);
        websocket._receiver.on("finish", receiverOnFinish);
      }
    }
    function socketOnData(chunk) {
      if (!this[kWebSocket]._receiver.write(chunk)) {
        this.pause();
      }
    }
    function socketOnEnd() {
      const websocket = this[kWebSocket];
      websocket._readyState = WebSocket2.CLOSING;
      websocket._receiver.end();
      this.end();
    }
    function socketOnError() {
      const websocket = this[kWebSocket];
      this.removeListener("error", socketOnError);
      this.on("error", NOOP);
      if (websocket) {
        websocket._readyState = WebSocket2.CLOSING;
        this.destroy();
      }
    }
  }
});

// node_modules/ws/lib/stream.js
var require_stream = __commonJS({
  "node_modules/ws/lib/stream.js"(exports, module) {
    "use strict";
    var WebSocket2 = require_websocket();
    var { Duplex } = __require("stream");
    function emitClose(stream) {
      stream.emit("close");
    }
    function duplexOnEnd() {
      if (!this.destroyed && this._writableState.finished) {
        this.destroy();
      }
    }
    function duplexOnError(err) {
      this.removeListener("error", duplexOnError);
      this.destroy();
      if (this.listenerCount("error") === 0) {
        this.emit("error", err);
      }
    }
    function createWebSocketStream2(ws, options) {
      let terminateOnDestroy = true;
      const duplex = new Duplex({
        ...options,
        autoDestroy: false,
        emitClose: false,
        objectMode: false,
        writableObjectMode: false
      });
      ws.on("message", function message(msg, isBinary) {
        const data = !isBinary && duplex._readableState.objectMode ? msg.toString() : msg;
        if (!duplex.push(data)) ws.pause();
      });
      ws.once("error", function error(err) {
        if (duplex.destroyed) return;
        terminateOnDestroy = false;
        duplex.destroy(err);
      });
      ws.once("close", function close() {
        if (duplex.destroyed) return;
        duplex.push(null);
      });
      duplex._destroy = function(err, callback) {
        if (ws.readyState === ws.CLOSED) {
          callback(err);
          process.nextTick(emitClose, duplex);
          return;
        }
        let called = false;
        ws.once("error", function error(err2) {
          called = true;
          callback(err2);
        });
        ws.once("close", function close() {
          if (!called) callback(err);
          process.nextTick(emitClose, duplex);
        });
        if (terminateOnDestroy) ws.terminate();
      };
      duplex._final = function(callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open4() {
            duplex._final(callback);
          });
          return;
        }
        if (ws._socket === null) return;
        if (ws._socket._writableState.finished) {
          callback();
          if (duplex._readableState.endEmitted) duplex.destroy();
        } else {
          ws._socket.once("finish", function finish() {
            callback();
          });
          ws.close();
        }
      };
      duplex._read = function() {
        if (ws.isPaused) ws.resume();
      };
      duplex._write = function(chunk, encoding, callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open4() {
            duplex._write(chunk, encoding, callback);
          });
          return;
        }
        ws.send(chunk, callback);
      };
      duplex.on("end", duplexOnEnd);
      duplex.on("error", duplexOnError);
      return duplex;
    }
    module.exports = createWebSocketStream2;
  }
});

// node_modules/ws/lib/subprotocol.js
var require_subprotocol = __commonJS({
  "node_modules/ws/lib/subprotocol.js"(exports, module) {
    "use strict";
    var { tokenChars } = require_validation();
    function parse2(header) {
      const protocols = /* @__PURE__ */ new Set();
      let start = -1;
      let end = -1;
      let i = 0;
      for (i; i < header.length; i++) {
        const code = header.charCodeAt(i);
        if (end === -1 && tokenChars[code] === 1) {
          if (start === -1) start = i;
        } else if (i !== 0 && (code === 32 || code === 9)) {
          if (end === -1 && start !== -1) end = i;
        } else if (code === 44) {
          if (start === -1) {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
          if (end === -1) end = i;
          const protocol2 = header.slice(start, end);
          if (protocols.has(protocol2)) {
            throw new SyntaxError(`The "${protocol2}" subprotocol is duplicated`);
          }
          protocols.add(protocol2);
          start = end = -1;
        } else {
          throw new SyntaxError(`Unexpected character at index ${i}`);
        }
      }
      if (start === -1 || end !== -1) {
        throw new SyntaxError("Unexpected end of input");
      }
      const protocol = header.slice(start, i);
      if (protocols.has(protocol)) {
        throw new SyntaxError(`The "${protocol}" subprotocol is duplicated`);
      }
      protocols.add(protocol);
      return protocols;
    }
    module.exports = { parse: parse2 };
  }
});

// node_modules/ws/lib/websocket-server.js
var require_websocket_server = __commonJS({
  "node_modules/ws/lib/websocket-server.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events");
    var http = __require("http");
    var { Duplex } = __require("stream");
    var { createHash: createHash5 } = __require("crypto");
    var extension2 = require_extension();
    var PerMessageDeflate2 = require_permessage_deflate();
    var subprotocol2 = require_subprotocol();
    var WebSocket2 = require_websocket();
    var { CLOSE_TIMEOUT, GUID, kWebSocket } = require_constants();
    var keyRegex = /^[+/0-9A-Za-z]{22}==$/;
    var RUNNING = 0;
    var CLOSING = 1;
    var CLOSED = 2;
    var WebSocketServer2 = class extends EventEmitter {
      /**
       * Create a `WebSocketServer` instance.
       *
       * @param {Object} options Configuration options
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Boolean} [options.autoPong=true] Specifies whether or not to
       *     automatically send a pong in response to a ping
       * @param {Number} [options.backlog=511] The maximum length of the queue of
       *     pending connections
       * @param {Boolean} [options.clientTracking=true] Specifies whether or not to
       *     track clients
       * @param {Number} [options.closeTimeout=30000] Duration in milliseconds to
       *     wait for the closing handshake to finish after `websocket.close()` is
       *     called
       * @param {Function} [options.handleProtocols] A hook to handle protocols
       * @param {String} [options.host] The hostname where to bind the server
       * @param {Number} [options.maxBufferedChunks=262144] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=16384] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=104857600] The maximum allowed message
       *     size
       * @param {Boolean} [options.noServer=false] Enable no server mode
       * @param {String} [options.path] Accept only connections matching this path
       * @param {(Boolean|Object)} [options.perMessageDeflate=false] Enable/disable
       *     permessage-deflate
       * @param {Number} [options.port] The port where to bind the server
       * @param {(http.Server|https.Server)} [options.server] A pre-created HTTP/S
       *     server to use
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @param {Function} [options.verifyClient] A hook to reject connections
       * @param {Function} [options.WebSocket=WebSocket] Specifies the `WebSocket`
       *     class to use. It must be the `WebSocket` class or class that extends it
       * @param {Function} [callback] A listener for the `listening` event
       */
      constructor(options, callback) {
        super();
        options = {
          allowSynchronousEvents: true,
          autoPong: true,
          maxBufferedChunks: 256 * 1024,
          maxFragments: 16 * 1024,
          maxPayload: 100 * 1024 * 1024,
          skipUTF8Validation: false,
          perMessageDeflate: false,
          handleProtocols: null,
          clientTracking: true,
          closeTimeout: CLOSE_TIMEOUT,
          verifyClient: null,
          noServer: false,
          backlog: null,
          // use default (511 as implemented in net.js)
          server: null,
          host: null,
          path: null,
          port: null,
          WebSocket: WebSocket2,
          ...options
        };
        if (options.port == null && !options.server && !options.noServer || options.port != null && (options.server || options.noServer) || options.server && options.noServer) {
          throw new TypeError(
            'One and only one of the "port", "server", or "noServer" options must be specified'
          );
        }
        if (options.port != null) {
          this._server = http.createServer((req, res) => {
            const body = http.STATUS_CODES[426];
            res.writeHead(426, {
              "Content-Length": body.length,
              "Content-Type": "text/plain"
            });
            res.end(body);
          });
          this._server.listen(
            options.port,
            options.host,
            options.backlog,
            callback
          );
        } else if (options.server) {
          this._server = options.server;
        }
        if (this._server) {
          const emitConnection = this.emit.bind(this, "connection");
          this._removeListeners = addListeners(this._server, {
            listening: this.emit.bind(this, "listening"),
            error: this.emit.bind(this, "error"),
            upgrade: (req, socket, head) => {
              this.handleUpgrade(req, socket, head, emitConnection);
            }
          });
        }
        if (options.perMessageDeflate === true) options.perMessageDeflate = {};
        if (options.clientTracking) {
          this.clients = /* @__PURE__ */ new Set();
          this._shouldEmitClose = false;
        }
        this.options = options;
        this._state = RUNNING;
      }
      /**
       * Returns the bound address, the address family name, and port of the server
       * as reported by the operating system if listening on an IP socket.
       * If the server is listening on a pipe or UNIX domain socket, the name is
       * returned as a string.
       *
       * @return {(Object|String|null)} The address of the server
       * @public
       */
      address() {
        if (this.options.noServer) {
          throw new Error('The server is operating in "noServer" mode');
        }
        if (!this._server) return null;
        return this._server.address();
      }
      /**
       * Stop the server from accepting new connections and emit the `'close'` event
       * when all existing connections are closed.
       *
       * @param {Function} [cb] A one-time listener for the `'close'` event
       * @public
       */
      close(cb) {
        if (this._state === CLOSED) {
          if (cb) {
            this.once("close", () => {
              cb(new Error("The server is not running"));
            });
          }
          process.nextTick(emitClose, this);
          return;
        }
        if (cb) this.once("close", cb);
        if (this._state === CLOSING) return;
        this._state = CLOSING;
        if (this.options.noServer || this.options.server) {
          if (this._server) {
            this._removeListeners();
            this._removeListeners = this._server = null;
          }
          if (this.clients) {
            if (!this.clients.size) {
              process.nextTick(emitClose, this);
            } else {
              this._shouldEmitClose = true;
            }
          } else {
            process.nextTick(emitClose, this);
          }
        } else {
          const server = this._server;
          this._removeListeners();
          this._removeListeners = this._server = null;
          server.close(() => {
            emitClose(this);
          });
        }
      }
      /**
       * See if a given request should be handled by this server instance.
       *
       * @param {http.IncomingMessage} req Request object to inspect
       * @return {Boolean} `true` if the request is valid, else `false`
       * @public
       */
      shouldHandle(req) {
        if (this.options.path) {
          const index = req.url.indexOf("?");
          const pathname = index !== -1 ? req.url.slice(0, index) : req.url;
          if (pathname !== this.options.path) return false;
        }
        return true;
      }
      /**
       * Handle a HTTP Upgrade request.
       *
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @public
       */
      handleUpgrade(req, socket, head, cb) {
        socket.on("error", socketOnError);
        const key = req.headers["sec-websocket-key"];
        const upgrade = req.headers.upgrade;
        const version = +req.headers["sec-websocket-version"];
        if (req.method !== "GET") {
          const message = "Invalid HTTP method";
          abortHandshakeOrEmitwsClientError(this, req, socket, 405, message);
          return;
        }
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          const message = "Invalid Upgrade header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (key === void 0 || !keyRegex.test(key)) {
          const message = "Missing or invalid Sec-WebSocket-Key header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (version !== 13 && version !== 8) {
          const message = "Missing or invalid Sec-WebSocket-Version header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message, {
            "Sec-WebSocket-Version": "13, 8"
          });
          return;
        }
        if (!this.shouldHandle(req)) {
          abortHandshake(socket, 400);
          return;
        }
        const secWebSocketProtocol = req.headers["sec-websocket-protocol"];
        let protocols = /* @__PURE__ */ new Set();
        if (secWebSocketProtocol !== void 0) {
          try {
            protocols = subprotocol2.parse(secWebSocketProtocol);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Protocol header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        const secWebSocketExtensions = req.headers["sec-websocket-extensions"];
        const extensions = {};
        if (this.options.perMessageDeflate && secWebSocketExtensions !== void 0) {
          const perMessageDeflate = new PerMessageDeflate2({
            ...this.options.perMessageDeflate,
            isServer: true,
            maxPayload: this.options.maxPayload
          });
          try {
            const offers = extension2.parse(secWebSocketExtensions);
            if (offers[PerMessageDeflate2.extensionName]) {
              perMessageDeflate.accept(offers[PerMessageDeflate2.extensionName]);
              extensions[PerMessageDeflate2.extensionName] = perMessageDeflate;
            }
          } catch (err) {
            const message = "Invalid or unacceptable Sec-WebSocket-Extensions header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        if (this.options.verifyClient) {
          const info = {
            origin: req.headers[`${version === 8 ? "sec-websocket-origin" : "origin"}`],
            secure: !!(req.socket.authorized || req.socket.encrypted),
            req
          };
          if (this.options.verifyClient.length === 2) {
            this.options.verifyClient(info, (verified, code, message, headers) => {
              if (!verified) {
                return abortHandshake(socket, code || 401, message, headers);
              }
              this.completeUpgrade(
                extensions,
                key,
                protocols,
                req,
                socket,
                head,
                cb
              );
            });
            return;
          }
          if (!this.options.verifyClient(info)) return abortHandshake(socket, 401);
        }
        this.completeUpgrade(extensions, key, protocols, req, socket, head, cb);
      }
      /**
       * Upgrade the connection to WebSocket.
       *
       * @param {Object} extensions The accepted extensions
       * @param {String} key The value of the `Sec-WebSocket-Key` header
       * @param {Set} protocols The subprotocols
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @throws {Error} If called more than once with the same socket
       * @private
       */
      completeUpgrade(extensions, key, protocols, req, socket, head, cb) {
        if (!socket.readable || !socket.writable) return socket.destroy();
        if (socket[kWebSocket]) {
          throw new Error(
            "server.handleUpgrade() was called more than once with the same socket, possibly due to a misconfiguration"
          );
        }
        if (this._state > RUNNING) return abortHandshake(socket, 503);
        const digest = createHash5("sha1").update(key + GUID).digest("base64");
        const headers = [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${digest}`
        ];
        const ws = new this.options.WebSocket(null, void 0, this.options);
        if (protocols.size) {
          const protocol = this.options.handleProtocols ? this.options.handleProtocols(protocols, req) : protocols.values().next().value;
          if (protocol) {
            headers.push(`Sec-WebSocket-Protocol: ${protocol}`);
            ws._protocol = protocol;
          }
        }
        if (extensions[PerMessageDeflate2.extensionName]) {
          const params = extensions[PerMessageDeflate2.extensionName].params;
          const value = extension2.format({
            [PerMessageDeflate2.extensionName]: [params]
          });
          headers.push(`Sec-WebSocket-Extensions: ${value}`);
          ws._extensions = extensions;
        }
        this.emit("headers", headers, req);
        socket.write(headers.concat("\r\n").join("\r\n"));
        socket.removeListener("error", socketOnError);
        ws.setSocket(socket, head, {
          allowSynchronousEvents: this.options.allowSynchronousEvents,
          maxBufferedChunks: this.options.maxBufferedChunks,
          maxFragments: this.options.maxFragments,
          maxPayload: this.options.maxPayload,
          skipUTF8Validation: this.options.skipUTF8Validation
        });
        if (this.clients) {
          this.clients.add(ws);
          ws.on("close", () => {
            this.clients.delete(ws);
            if (this._shouldEmitClose && !this.clients.size) {
              process.nextTick(emitClose, this);
            }
          });
        }
        cb(ws, req);
      }
    };
    module.exports = WebSocketServer2;
    function addListeners(server, map) {
      for (const event of Object.keys(map)) server.on(event, map[event]);
      return function removeListeners() {
        for (const event of Object.keys(map)) {
          server.removeListener(event, map[event]);
        }
      };
    }
    function emitClose(server) {
      server._state = CLOSED;
      server.emit("close");
    }
    function socketOnError() {
      this.destroy();
    }
    function abortHandshake(socket, code, message, headers) {
      message = message || http.STATUS_CODES[code];
      headers = {
        Connection: "close",
        "Content-Type": "text/html",
        "Content-Length": Buffer.byteLength(message),
        ...headers
      };
      socket.once("finish", socket.destroy);
      socket.end(
        `HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r
` + Object.keys(headers).map((h) => `${h}: ${headers[h]}`).join("\r\n") + "\r\n\r\n" + message
      );
    }
    function abortHandshakeOrEmitwsClientError(server, req, socket, code, message, headers) {
      if (server.listenerCount("wsClientError")) {
        const err = new Error(message);
        Error.captureStackTrace(err, abortHandshakeOrEmitwsClientError);
        server.emit("wsClientError", err, socket, req);
      } else {
        abortHandshake(socket, code, message, headers);
      }
    }
  }
});

// src/doctor.ts
import { access, readFile as readFile2 } from "node:fs/promises";
import { join as join4 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync as realpathSync2 } from "node:fs";

// src/util.ts
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
var hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function command(argv, options = {}) {
  options.signal?.throwIfAborted();
  return new Promise((resolve4, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], signal: options.signal });
    let stdout = "", stderr = "", size = 0;
    let failure;
    const timer = setTimeout(() => {
      failure = new Error(`Command timed out: ${argv[0]}`);
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 1e4);
    const consume = (channel, chunk) => {
      size += chunk.length;
      if (size > (options.maxBytes ?? 128 * 1024)) {
        failure = new Error(`Command output exceeded limit: ${argv[0]}`);
        child.kill("SIGKILL");
        return;
      }
      if (channel === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.on("data", (chunk) => consume("stdout", chunk));
    child.stderr.on("data", (chunk) => consume("stderr", chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else resolve4({ stdout, stderr, code: code ?? -1 });
    });
  });
}

// src/machine-service.ts
import { isIP as isIP4 } from "node:net";
import { createHash as createHash4, randomUUID as randomUUID3 } from "node:crypto";
import { open as open2, rename, rm, stat } from "node:fs/promises";
import { basename } from "node:path";

// src/environment.ts
import { accessSync, constants, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createHash as createHash2 } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { isIP } from "node:net";
var paths = ["imageRepository", "tartHome", "serviceStateDir", "imageStateDir", "relayStateDir", "machctlPath", "tartPath"];
var mutable = ["tartHome", "serviceStateDir", "imageStateDir", "relayStateDir"];
var LEGACY_PROFILE = "Environment profile is from before the machine-service rename, which reads only schemaVersion 2 with machctlPath: a profile at schemaVersion 1 or with vmctlPath is refused. Rename vmctlPath to machctlPath, naming the machctl executable, and set schemaVersion to 2.";
function canonicalPath(value) {
  if (typeof value !== "string" || !isAbsolute(value) || !value.trim() || /[\x00-\x1f\x7f\uD800-\uDFFF]/u.test(value)) throw new Error("Environment paths must be absolute and contain no control characters");
  let ancestor = resolve(value);
  const suffix = [];
  for (; ; ) {
    try {
      return join(realpathSync(ancestor), ...suffix);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      try {
        if (lstatSync(ancestor).isSymbolicLink()) throw new Error("Dangling environment path symlink");
      } catch (entryError) {
        if (entryError.code !== "ENOENT") throw entryError;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(relative(parent, ancestor));
      ancestor = parent;
    }
  }
}
function overlaps(a, b) {
  const below = (parent, child) => {
    const r = relative(parent, child);
    return r === "" || !r.startsWith("../") && r !== ".." && !isAbsolute(r);
  };
  return below(a, b) || below(b, a);
}
function endpoint(value) {
  if (typeof value !== "string") throw new Error("vmServiceUrl must be a loopback HTTP origin with an explicit port");
  const match = /^http:\/\/(localhost|127(?:\.\d{1,3}){3}|\[::1\]):([0-9]{1,5})\/?$/.exec(value);
  if (!match || !["localhost", "[::1]"].includes(match[1]) && isIP(match[1]) !== 4) throw new Error("vmServiceUrl must be a loopback HTTP origin with an explicit port");
  const port = Number(match[2]);
  if (port < 1 || port > 65535) throw new Error("Environment port must be between 1 and 65535");
  return `http://${match[1]}:${port}`;
}
function loadEnvironment(path, env = process.env, home = env.HOME ?? homedir()) {
  const canonical = canonicalPath(resolve(path));
  const info = statSync(canonical);
  if (!info.isFile() || info.size > 65536) throw new Error("Environment profile must be a regular JSON file under 64 KiB");
  const bytes = readFileSync(canonical);
  if (bytes.length > 65536) throw new Error("Environment profile exceeds 64 KiB");
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const raw = JSON.parse(text);
  let depth = 0;
  const seen = /* @__PURE__ */ new Set();
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') {
      const start = i++;
      for (; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      let next = i + 1;
      while (/\s/.test(text[next] ?? "") && next < text.length) next++;
      if (depth === 1 && text[next] === ":") {
        const key = JSON.parse(text.slice(start, i + 1));
        if (seen.has(key)) throw new Error(`Duplicate environment profile key: ${key}`);
        seen.add(key);
      }
    } else if (text[i] === "{" || text[i] === "[") depth++;
    else if (text[i] === "}" || text[i] === "]") depth--;
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw) && (raw.schemaVersion === 1 || Object.hasOwn(raw, "vmctlPath"))) throw new Error(LEGACY_PROFILE);
  const fields = ["schemaVersion", "id", "vmServiceUrl", ...paths].sort();
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || JSON.stringify(Object.keys(raw).sort()) !== JSON.stringify(fields)) throw new Error("Environment profile has missing or unknown fields");
  const p = raw;
  if (p.schemaVersion !== 2 || typeof p.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(p.id)) throw new Error("Invalid environment schemaVersion or id");
  const profile = { schemaVersion: 2, id: p.id, vmServiceUrl: endpoint(p.vmServiceUrl) };
  for (const key of paths) profile[key] = canonicalPath(p[key]);
  if (!statSync(profile.imageRepository).isDirectory() || !statSync(join(profile.imageRepository, "images")).isDirectory()) throw new Error("Selected imageRepository must contain images/");
  for (const key of ["machctlPath", "tartPath"]) {
    if (!statSync(profile[key]).isFile()) throw new Error(`${key} must be a regular executable file`);
    accessSync(profile[key], constants.X_OK);
  }
  const state = env.XDG_STATE_HOME ? canonicalPath(env.XDG_STATE_HOME) : join(canonicalPath(home), ".local/state");
  const names = ["machine-service", "vm-service", "pilot-images", "mcp-relay", "mcp-vm-relay"];
  const defaults = [join(canonicalPath(home), ".tart"), ...names.map((n) => join(state, n)), ...names.map((n) => join(canonicalPath(home), ".local/state", n))].map(canonicalPath);
  for (const key of mutable) {
    const value = profile[key];
    try {
      if (!statSync(value).isDirectory()) throw new Error(`${key} must be a directory`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (overlaps(value, profile.imageRepository) || defaults.some((root) => overlaps(value, root))) throw new Error(`${key} overlaps the repository or a legacy default store/state root`);
    for (const other of mutable) if (key !== other && overlaps(value, profile[other])) throw new Error("Environment mutable roots must be disjoint");
  }
  const ordered = Object.fromEntries(Object.keys(profile).sort().map((k) => [k, profile[k]]));
  const fingerprint = createHash2("sha256").update(JSON.stringify(ordered), "utf8").digest("hex");
  const identity = Object.freeze({
    id: profile.id,
    fingerprint,
    vmServiceUrl: profile.vmServiceUrl,
    imageRepository: profile.imageRepository,
    tartHome: profile.tartHome,
    serviceStateDir: profile.serviceStateDir,
    imageStateDir: profile.imageStateDir,
    relayStateDir: profile.relayStateDir
  });
  return Object.freeze({ path: canonical, profile: Object.freeze(profile), identity });
}
function selectedEnvironment(env = process.env, home) {
  if (env.VM_ENVIRONMENT_FILE === void 0) return void 0;
  if (!env.VM_ENVIRONMENT_FILE.trim()) throw new Error("VM_ENVIRONMENT_FILE must not be blank");
  return loadEnvironment(env.VM_ENVIRONMENT_FILE, env, home);
}
function environmentVariables(selected) {
  const p = selected.profile;
  const url = new URL(p.vmServiceUrl);
  return {
    VM_ENVIRONMENT_FILE: selected.path,
    VM_ENVIRONMENT_FINGERPRINT: selected.identity.fingerprint,
    PILOT_REPO: p.imageRepository,
    TART_HOME: p.tartHome,
    MACHINE_SERVICE_STATE: p.serviceStateDir,
    PILOT_IMAGES_STATE_DIR: p.imageStateDir,
    VM_RELAY_STATE_DIR: p.relayStateDir,
    VM_RELAY_URL: p.vmServiceUrl,
    MACHINE_SERVICE_HOST: url.hostname.replace(/^\[|\]$/g, ""),
    MACHINE_SERVICE_PORT: String(Number(p.vmServiceUrl.match(/:([0-9]+)$/)[1])),
    MACHCTL: p.machctlPath,
    TART: p.tartPath
  };
}
function matchesEnvironment(actual, selected) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const identity = actual;
  return Object.keys(identity).length === Object.keys(selected.identity).length && Object.entries(selected.identity).every(([key, value]) => identity[key] === value);
}

// src/config.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { isIP as isIP2 } from "node:net";
import { homedir as homedir2 } from "node:os";
import { isAbsolute as isAbsolute2, join as join2, normalize } from "node:path";
function nonblank(value, label) {
  if (!value.trim() || value.includes("\0")) throw new TypeError(`${label} must be nonblank text without NUL characters`);
  return value;
}
function absolute(value, label) {
  nonblank(value, label);
  if (!isAbsolute2(value)) throw new TypeError(`${label} must be an absolute path`);
  return normalize(value);
}
function localTartHost(platform = process.platform, arch = process.arch) {
  return platform === "darwin" && arch === "arm64";
}
var INSTALLED_SERVICE_URL = "http://localhost:6240";
var ISOLATION_VARIABLE = "MCP_RELAY_ISOLATED";
function isolated(env = process.env) {
  return env[ISOLATION_VARIABLE] === "1";
}
function installedOrigin(url) {
  const parsed = new URL(url);
  return parsed.port === new URL(INSTALLED_SERVICE_URL).port && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
}
function serviceUrl(env = process.env, environment = selectedEnvironment(env)) {
  const named2 = environment?.profile.vmServiceUrl ?? env.MCP_RELAY_URL;
  if (!isolated(env)) return named2 ?? INSTALLED_SERVICE_URL;
  if (named2 === void 0) throw new Error(`${ISOLATION_VARIABLE}=1: name the machine-service origin with MCP_RELAY_URL or VM_ENVIRONMENT_FILE; a test gets no default`);
  if (installedOrigin(named2)) throw new Error(`${ISOLATION_VARIABLE}=1: ${named2} is the installed machine-service's origin, which no test may reach`);
  return named2;
}
function relayStateRoot(options = {}) {
  const env = options.env ?? process.env;
  const selected = selectedEnvironment(env, options.home);
  if (selected) return selected.profile.relayStateDir;
  if (env.MCP_RELAY_STATE_DIR !== void 0) return absolute(env.MCP_RELAY_STATE_DIR, "MCP_RELAY_STATE_DIR");
  if (env.XDG_STATE_HOME !== void 0) return join2(absolute(env.XDG_STATE_HOME, "XDG_STATE_HOME"), "mcp-relay");
  return join2(absolute(options.home ?? env.HOME ?? homedir2(), "home"), ".local", "state", "mcp-relay");
}
function pythonExecutable(env = process.env) {
  return nonblank(env.MCP_RELAY_PYTHON ?? "python3", "MCP_RELAY_PYTHON");
}
function brokerRoute(env = process.env) {
  const route = {};
  const resolve4 = env.MCP_RELAY_BROKER_RESOLVE;
  if (resolve4 !== void 0 && resolve4 !== "") {
    const at = resolve4.indexOf("=");
    const host = resolve4.slice(0, at).toLowerCase(), address = resolve4.slice(at + 1);
    if (at <= 0 || !/^[a-z0-9.-]+$/.test(host) || isIP2(address) === 0) throw new TypeError(`MCP_RELAY_BROKER_RESOLVE must be <host name>=<IP address>, not ${JSON.stringify(resolve4)}`);
    route.resolve = { host, address };
  }
  const ca = env.MCP_RELAY_BROKER_CA;
  if (ca !== void 0 && ca !== "") {
    const pem = readFileSync2(absolute(ca, "MCP_RELAY_BROKER_CA"), "utf8");
    if (!pem.includes("-----BEGIN CERTIFICATE-----")) throw new TypeError("MCP_RELAY_BROKER_CA must name a PEM certificate file");
    route.caPem = pem;
  }
  return route;
}

// src/relay-client.ts
import { createHash as createHash3, randomUUID as randomUUID2, X509Certificate } from "node:crypto";
import { open } from "node:fs/promises";
import { lookup as dnsLookup } from "node:dns";
import { isIP as isIP3 } from "node:net";
import { rootCertificates } from "node:tls";

// node_modules/ws/wrapper.mjs
var import_stream = __toESM(require_stream(), 1);
var import_extension = __toESM(require_extension(), 1);
var import_permessage_deflate = __toESM(require_permessage_deflate(), 1);
var import_receiver = __toESM(require_receiver(), 1);
var import_sender = __toESM(require_sender(), 1);
var import_subprotocol = __toESM(require_subprotocol(), 1);
var import_websocket = __toESM(require_websocket(), 1);
var import_websocket_server = __toESM(require_websocket_server(), 1);
var wrapper_default = import_websocket.default;

// src/relay-session.ts
var MAX_MESSAGE = 1 << 20;
var ENVELOPE_HEADER = 16;
var MAX_BODY = MAX_MESSAGE - ENVELOPE_HEADER;
var SESSION_VERSION = 1;
var MAX_HEARTBEAT_MS = 3e4;
var MAX_BUFFERED = 64 << 20;
var MIN_WINDOW = MAX_MESSAGE;
var INITIAL_WINDOW = MIN_WINDOW;
var DEFAULT_TIMING = { heartbeatMs: 5e3, deadMs: 15e3, handshakeMs: 1e4, backoffInitialMs: 250, backoffMaxMs: 5e3, tickMs: 250, openMs: 3e4 };
function backoffDelay(attempt, unit, timing = DEFAULT_TIMING) {
  const base = Math.min(timing.backoffInitialMs * 2 ** Math.min(attempt, 16), timing.backoffMaxMs);
  return base * (0.5 + 0.5 * Math.min(Math.max(unit, 0), 1));
}
function encodeEnvelope({ seq, ack, body }) {
  const out = Buffer.allocUnsafe(ENVELOPE_HEADER + body.length);
  out.writeBigUInt64BE(BigInt(seq), 0);
  out.writeBigUInt64BE(BigInt(ack), 8);
  body.copy(out, ENVELOPE_HEADER);
  return out;
}
function decodeEnvelope(bytes) {
  if (bytes.length < ENVELOPE_HEADER) throw new ProtocolError(`an envelope of ${bytes.length} bytes is shorter than its header`);
  const word = (at) => {
    const value = bytes.readBigUInt64BE(at);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ProtocolError("a sequence number beyond 2^53");
    return Number(value);
  };
  return { seq: word(0), ack: word(8), body: bytes.subarray(ENVELOPE_HEADER) };
}
var ProtocolError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ProtocolError";
  }
};
var SessionRejected = class extends Error {
  constructor(code, message) {
    super(`the broker refused the session: ${code}: ${message}`);
    this.code = code;
    this.name = "SessionRejected";
  }
  code;
};
var ConnectError = class extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ConnectError";
  }
};
var SeqState = class {
  /** The highest sequence number this side assigned. */
  last = 0;
  /** Bodies the peer has not acknowledged, in order, from `acked + 1`. */
  outbox = [];
  outboxBytes = 0;
  /** The highest sequence number the peer acknowledged. */
  acked = 0;
  /** The highest sequence number received without a gap. */
  received = 0;
  /** The highest sequence number written on the current connection. */
  cursor = 0;
  /** The `received` last told to the peer on the current connection. */
  ackSent = 0;
  /** Bytes of the bodies written on the current connection and not yet acknowledged. */
  inFlight = 0;
  /** Bytes of every body the peer acknowledged, over the session. */
  ackedBytes = 0;
  push(body) {
    this.last++;
    this.outbox.push(body);
    this.outboxBytes += body.length;
    return this.last;
  }
  /** A body to deliver, or undefined for a duplicate; a gap throws. */
  accept(envelope) {
    this.ack(envelope.ack);
    const expected = this.received + 1;
    if (envelope.seq < expected) return void 0;
    if (envelope.seq > expected) throw new ProtocolError(`gap in sequence: expected ${expected}, got ${envelope.seq}`);
    this.received = envelope.seq;
    return envelope.body;
  }
  /** Drop every buffered body up to `ack`; a stale, lower one is ignored. */
  ack(ack) {
    if (ack > this.last) throw new ProtocolError(`acknowledgement ${ack} is beyond the last sent sequence ${this.last}`);
    while (this.acked < ack) {
      const length = this.outbox.shift().length;
      this.outboxBytes -= length;
      this.ackedBytes += length;
      if (this.acked < this.cursor) this.inFlight -= length;
      this.acked++;
    }
  }
  /** A new connection on which the peer reports `peerReceived`: above it is resent, up to it is dropped. */
  resume(peerReceived) {
    if (peerReceived < this.acked) throw new ProtocolError(`the broker reports ${peerReceived} received, below its earlier acknowledgement ${this.acked}`);
    this.ack(peerReceived);
    this.cursor = peerReceived;
    this.inFlight = 0;
    this.ackSent = 0;
  }
  /** The next envelope to write, if the bytes in flight stay within `window`; with nothing in flight one body always goes. */
  next(window = Infinity) {
    if (this.cursor < this.acked) {
      this.cursor = this.acked;
      this.inFlight = 0;
    }
    const body = this.outbox[this.cursor - this.acked];
    if (!body) return void 0;
    if (this.inFlight > 0 && this.inFlight + body.length > window) return void 0;
    this.inFlight += body.length;
    this.cursor++;
    this.ackSent = this.received;
    return { seq: this.cursor, ack: this.received, body };
  }
  get needsAck() {
    return this.received > this.ackSent;
  }
  markAckSent() {
    this.ackSent = this.received;
    return this.received;
  }
  /** Whether bodies written on the current connection wait for an acknowledgement. */
  get awaitingAck() {
    return this.cursor > this.acked;
  }
  /** Whether any body waits for an acknowledgement, written or not. */
  get busy() {
    return this.outbox.length > 0;
  }
};
var FlowWindow = class {
  constructor(deadMs, ceiling = MAX_BUFFERED) {
    this.ceiling = ceiling;
    this.drainMs = deadMs / 3;
    this.spanMs = this.drainMs * 2;
    this.window = Math.min(Math.max(INITIAL_WINDOW, MIN_WINDOW), Math.max(ceiling, MIN_WINDOW));
  }
  ceiling;
  window;
  drainMs;
  spanMs;
  points = [];
  /** Observe the bytes acknowledged so far, whether bodies wait for one, and the smallest round trip seen. */
  observe(now, ackedBytes, busy, minRttMs) {
    if (!busy) {
      this.points.length = 0;
      return;
    }
    const last = this.points.at(-1);
    if (last && now - last.at < 250) return;
    this.points.push({ at: now, bytes: ackedBytes });
    while (this.points.length > 2 && now - this.points[1].at >= this.spanMs) this.points.shift();
    const first = this.points[0];
    const covered = now - first.at;
    if (covered < Math.max(1e3, 2 * (minRttMs ?? 0))) return;
    const rate = (ackedBytes - first.bytes) / covered;
    if (rate <= 0) return;
    const window = Math.floor(rate * (this.drainMs + (minRttMs ?? 0)));
    this.window = Math.min(Math.max(window, MIN_WINDOW), Math.max(this.ceiling, MIN_WINDOW));
  }
};
var sleep = (ms) => new Promise((done) => setTimeout(done, Math.max(0, ms)));
function parseReply(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProtocolError("the answer to hello is not JSON");
  }
  if (value?.type === "welcome" && typeof value.session === "string" && typeof value.resumed === "boolean" && Number.isSafeInteger(value.received) && Number.isSafeInteger(value.heartbeat_ms) && Number.isSafeInteger(value.grace_ms)) return value;
  if (value?.type === "expired" && typeof value.session === "string" && ["expired", "unknown"].includes(value.reason)) return value;
  if (value?.type === "error" && typeof value.code === "string") return { type: "error", code: value.code, message: String(value.message ?? "") };
  throw new ProtocolError(`unexpected answer to hello: ${text.slice(0, 200)}`);
}
var ResumableSession = class _ResumableSession {
  constructor(options) {
    this.options = options;
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    if (!(this.timing.heartbeatMs > 0 && this.timing.heartbeatMs <= MAX_HEARTBEAT_MS)) throw new RangeError("heartbeatMs must be above zero and at most 30 s (TC-3)");
    if (this.timing.deadMs <= this.timing.heartbeatMs) throw new RangeError("deadMs must be longer than heartbeatMs");
    this.heartbeatMs = this.timing.heartbeatMs;
    this.random = options.random ?? Math.random;
  }
  options;
  timing;
  id = "";
  ended;
  seq = new SeqState();
  link;
  /** Each connection attempt has its own generation; events of an older one are ignored. */
  generation = 0;
  /** The connection whose welcome is awaited; what arrives after the welcome and before `attach` waits in `early`. */
  handshake;
  heartbeatMs;
  graceMs = 6e5;
  lastRx = 0;
  lastTx = 0;
  ackProgress = { acked: 0, at: 0 };
  flow;
  /** Envelopes written on the current connection, for round-trip samples. */
  written = [];
  /** The smallest round trip seen, from an envelope's write to the acknowledgement that covers it. */
  minRttMs;
  ticker;
  flushQueued = false;
  wake;
  drainWaiters = [];
  random;
  static async open(options) {
    const session = new _ResumableSession(options);
    const giveUp = Date.now() + session.timing.openMs;
    for (let attempt = 0; ; attempt++) {
      let connected;
      try {
        connected = await session.connect(null, 0);
      } catch (error) {
        if (!(error instanceof ConnectError) || Date.now() >= giveUp) throw error;
        await sleep(Math.min(backoffDelay(attempt, session.random(), session.timing), giveUp - Date.now()));
        continue;
      }
      const { link: link2, reply } = connected;
      if (reply.type === "error") {
        session.abandon(link2);
        throw new SessionRejected(reply.code, reply.message);
      }
      if (reply.type !== "welcome" || reply.resumed) {
        session.abandon(link2);
        throw new ProtocolError(`the broker answered a new session with ${JSON.stringify(reply)}`);
      }
      session.id = reply.session;
      session.attach(connected, reply);
      return session;
    }
  }
  /** Queue one body; it goes out now when connected, else after the session resumes. */
  send(body) {
    if (this.ended) throw new Error(`the session has ended (${this.ended.kind})`);
    if (body.length > MAX_BODY) throw new RangeError(`a body of ${body.length} bytes exceeds ${MAX_BODY}`);
    this.seq.push(body);
    this.flush();
  }
  /** Bytes sent and not yet acknowledged. */
  get unacknowledged() {
    return this.seq.outboxBytes;
  }
  /** Resolves once at most `limit` bytes wait for an acknowledgement, or the session ended. */
  drained(limit) {
    if (this.ended || this.seq.outboxBytes <= limit) return Promise.resolve();
    return new Promise((done) => this.drainWaiters.push({ limit, done }));
  }
  /** Close the session on purpose with `bye`; neither side resumes it. */
  close() {
    if (this.ended) return;
    if (this.link) {
      try {
        this.link.send(JSON.stringify({ type: "bye" }));
      } catch {
      }
    }
    this.finish({ kind: "closed", byPeer: false });
  }
  /** Drop the current connection as a broken link would; the session resumes on a new one. Tests use it. */
  dropConnection(reason = "dropped") {
    if (this.link) this.lost(this.generation, reason);
  }
  async connect(session, received) {
    const generation = ++this.generation;
    const handlers = { message: (data) => this.receive(generation, data), closed: (reason) => this.lost(generation, reason) };
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ConnectError(`no welcome within ${this.timing.handshakeMs} ms`)), this.timing.handshakeMs);
    });
    let link2;
    try {
      const opening = this.options.dial(handlers);
      opening.catch(() => {
      });
      link2 = await Promise.race([opening, timeout]).catch((error) => {
        throw error instanceof ConnectError ? error : new ConnectError(error instanceof Error ? error.message : String(error), { cause: error });
      });
      const answered = new Promise((resolve4, reject) => {
        this.handshake = { generation, answered: false, early: [], resolve: resolve4, reject };
      });
      link2.send(JSON.stringify({ type: "hello", version: SESSION_VERSION, session, received, credential: this.options.credential, attributes: this.options.attributes ?? { role: "client" } }));
      const reply = await Promise.race([answered, timeout]);
      return { link: link2, reply, generation };
    } catch (error) {
      this.abandon(link2);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  /** Forget a connection that will not carry the session. */
  abandon(link2) {
    this.handshake = void 0;
    this.generation++;
    try {
      link2?.close();
    } catch {
    }
  }
  attach({ link: link2, generation }, welcome) {
    this.seq.resume(welcome.received);
    const early = this.handshake?.generation === generation ? this.handshake.early : [];
    this.handshake = void 0;
    this.link = link2;
    this.heartbeatMs = Math.min(this.timing.heartbeatMs, welcome.heartbeat_ms > 0 ? welcome.heartbeat_ms : this.timing.heartbeatMs, MAX_HEARTBEAT_MS);
    this.graceMs = welcome.grace_ms;
    const now = Date.now();
    this.lastRx = now;
    this.lastTx = now;
    this.ackProgress = { acked: this.seq.acked, at: now };
    this.flow = new FlowWindow(this.timing.deadMs);
    this.written = [];
    clearInterval(this.ticker);
    this.ticker = setInterval(() => this.tick(generation), this.timing.tickMs);
    this.ticker.unref?.();
    this.settleDrains();
    this.flush();
    for (const data of early) this.receive(generation, data);
  }
  receive(generation, data) {
    if (generation !== this.generation || this.ended) return;
    this.lastRx = Date.now();
    const handshake = this.handshake;
    if (handshake?.generation === generation) {
      if (handshake.answered) {
        handshake.early.push(data);
        return;
      }
      handshake.answered = true;
      if (typeof data !== "string") return handshake.reject(new ProtocolError("an envelope before the welcome"));
      try {
        handshake.resolve(parseReply(data));
      } catch (error) {
        handshake.reject(error);
      }
      return;
    }
    try {
      if (typeof data === "string") {
        let control;
        try {
          control = JSON.parse(data);
        } catch {
          throw new ProtocolError("a text message that is not JSON");
        }
        if (control?.type === "ack" && Number.isSafeInteger(control.ack)) {
          this.seq.ack(control.ack);
          this.acknowledged();
          return;
        }
        if (control?.type === "bye") {
          this.finish({ kind: "closed", byPeer: true });
          return;
        }
        throw new ProtocolError(`unexpected ${String(control?.type)} after the handshake`);
      }
      const body = this.seq.accept(decodeEnvelope(data));
      this.acknowledged();
      if (body) {
        this.flush();
        try {
          this.options.onBody(Buffer.from(body));
        } catch {
        }
      }
    } catch (error) {
      this.lost(generation, `protocol error: ${error.message}`);
    }
  }
  /** The acknowledgement may have advanced: sample the round trip, wake senders, and fill the freed window. */
  acknowledged() {
    const now = Date.now();
    let sample;
    while (this.written.length && this.written[0].seq <= this.seq.acked) {
      const { seq, at } = this.written.shift();
      if (seq === this.seq.acked) sample = now - at;
    }
    if (sample !== void 0) this.minRttMs = Math.min(this.minRttMs ?? Infinity, sample);
    this.settleDrains();
    this.flush();
  }
  /** Write what the broker has not had on this connection, within the in-flight window, then an acknowledgement if one is owed. Nothing waits for an acknowledgement. */
  flush() {
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      const link2 = this.link;
      if (!link2 || this.ended) return;
      try {
        let wrote = false;
        const now = Date.now();
        for (let envelope = this.seq.next(this.flow.window); envelope; envelope = this.seq.next(this.flow.window)) {
          link2.send(encodeEnvelope(envelope));
          wrote = true;
          this.written.push({ seq: envelope.seq, at: now });
        }
        if (!wrote && this.seq.needsAck) link2.send(JSON.stringify({ type: "ack", ack: this.seq.markAckSent() }));
        else if (!wrote) return;
        this.lastTx = Date.now();
      } catch (error) {
        this.lost(this.generation, `send failed: ${error.message}`);
      }
    });
  }
  tick(generation) {
    if (generation !== this.generation || !this.link || this.ended) return;
    const now = Date.now();
    if (now - this.lastRx >= this.timing.deadMs) return this.lost(generation, "no traffic within the dead-connection bound");
    this.flow.observe(now, this.seq.ackedBytes, this.seq.busy, this.minRttMs);
    this.flush();
    if (this.seq.acked !== this.ackProgress.acked || !this.seq.awaitingAck) this.ackProgress = { acked: this.seq.acked, at: now };
    else if (now - this.ackProgress.at >= this.timing.deadMs) return this.lost(generation, "no acknowledgement within the dead-connection bound");
    if (now - this.lastTx >= this.heartbeatMs) {
      try {
        this.link.send(JSON.stringify({ type: "ack", ack: this.seq.markAckSent() }));
        this.lastTx = now;
      } catch (error) {
        this.lost(generation, `heartbeat failed: ${error.message}`);
      }
    }
  }
  lost(generation, reason) {
    if (generation !== this.generation || this.ended) return;
    if (this.handshake?.generation === generation) {
      this.handshake.reject(new ConnectError(reason));
      this.handshake.answered = true;
      return;
    }
    const link2 = this.link;
    if (!link2) return;
    this.link = void 0;
    this.generation++;
    clearInterval(this.ticker);
    this.ticker = void 0;
    try {
      link2.close();
    } catch {
    }
    this.options.onEvent?.({ kind: "lost", reason });
    void this.reconnect();
  }
  /**
   * Reconnect with backoff until resumed, or end the session. The broker may
   * notice the loss up to the dead-connection bound later than this side, so
   * after grace plus that bound it has surely dropped the session.
   */
  async reconnect() {
    const giveUp = Date.now() + this.graceMs + this.timing.deadMs;
    for (let attempt = 0; ; attempt++) {
      const pause = Math.min(backoffDelay(attempt, this.random(), this.timing), giveUp - Date.now());
      await new Promise((done) => {
        const timer = setTimeout(done, Math.max(0, pause));
        this.wake = () => {
          clearTimeout(timer);
          done();
        };
      });
      this.wake = void 0;
      if (this.ended) return;
      if (Date.now() >= giveUp) return this.finish({ kind: "expired", reason: "grace_elapsed" });
      let connected;
      try {
        connected = await this.connect(this.id, this.seq.received);
      } catch (error) {
        if (this.ended) return;
        if (error instanceof ConnectError) continue;
        return this.finish({ kind: "protocol", message: error.message });
      }
      const { link: link2, reply } = connected;
      if (this.ended) {
        this.abandon(link2);
        return;
      }
      if (reply.type === "welcome" && reply.resumed && reply.session === this.id) {
        try {
          this.attach(connected, reply);
        } catch (error) {
          this.abandon(link2);
          return this.finish({ kind: "protocol", message: error.message });
        }
        this.options.onEvent?.({ kind: "resumed" });
        return;
      }
      this.abandon(link2);
      if (reply.type === "expired") return this.finish({ kind: "expired", reason: reply.reason });
      if (reply.type === "error") return this.finish({ kind: "rejected", code: reply.code, message: reply.message });
      return this.finish({ kind: "protocol", message: `asked to resume ${this.id}, got a welcome for ${reply.session}` });
    }
  }
  settleDrains() {
    for (let i = this.drainWaiters.length - 1; i >= 0; i--) {
      const waiter = this.drainWaiters[i];
      if (this.ended || this.seq.outboxBytes <= waiter.limit) {
        this.drainWaiters.splice(i, 1);
        waiter.done();
      }
    }
  }
  finish(end) {
    if (this.ended) return;
    this.ended = end;
    clearInterval(this.ticker);
    this.ticker = void 0;
    const link2 = this.link;
    this.link = void 0;
    this.generation++;
    if (link2) {
      try {
        link2.close();
      } catch {
      }
    }
    this.wake?.();
    this.settleDrains();
    this.options.onEnd(end);
  }
};

// src/relay-client.ts
var MAX_CHUNK = MAX_MESSAGE - 4096;
var RELAY_PROTOCOL = 2;
var UPLOAD_WINDOW = 32 * 1024 * 1024;
var MAX_CONTINUATIONS = 20;
var CHUNK_TAG = 1;
var OUTPUT_KEPT = 16 * 1024 * 1024;
var kindOf = (op) => typeof op === "string" ? op : Object.keys(op)[0];
var uploads = (kind) => kind === "exec" || kind === "script" || kind === "write" || kind === "write_tree";
var streams = (kind) => kind === "exec" || kind === "script" || kind === "read" || kind === "read_tree";
var reads = (kind) => kind === "read" || kind === "read_tree";
function bufferSource(bytes) {
  return { size: bytes.length, sha256: createHash3("sha256").update(bytes).digest("hex"), read: async (offset, length) => bytes.subarray(offset, offset + length) };
}
async function fileSource(path) {
  const hash2 = createHash3("sha256");
  let size = 0;
  const file = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(MAX_CHUNK);
    for (; ; ) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, size);
      if (!bytesRead) break;
      hash2.update(buffer.subarray(0, bytesRead));
      size += bytesRead;
    }
  } finally {
    await file.close();
  }
  return {
    size,
    sha256: hash2.digest("hex"),
    read: async (offset, length) => {
      const reader = await open(path, "r");
      try {
        const out = Buffer.allocUnsafe(length);
        let filled = 0;
        while (filled < length) {
          const { bytesRead } = await reader.read(out, filled, length - filled, offset + filled);
          if (!bytesRead) throw new Error(`${path} ended before ${offset + length} bytes; it changed during the upload`);
          filled += bytesRead;
        }
        return out;
      } finally {
        await reader.close();
      }
    }
  };
}
function encodeChunk(call, data) {
  if (data.length > MAX_CHUNK) throw new RangeError(`a chunk of ${data.length} bytes exceeds ${MAX_CHUNK}`);
  const out = Buffer.allocUnsafe(9 + data.length);
  out[0] = CHUNK_TAG;
  out.writeBigUInt64BE(BigInt(call), 1);
  data.copy(out, 9);
  return out;
}
var encodeControl = (name, value) => Buffer.from(JSON.stringify(value === void 0 ? name : { [name]: value }));
function decodeMessage(body) {
  if (body[0] === CHUNK_TAG) {
    if (body.length < 9) throw new Error(`a chunk of ${body.length} bytes is shorter than its header`);
    return { chunk: { call: Number(body.readBigUInt64BE(1)), data: body.subarray(9) } };
  }
  const value = JSON.parse(body.toString("utf8"));
  if (typeof value === "string") return { name: value, value: void 0 };
  if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1) {
    const [name] = Object.keys(value);
    return { name, value: value[name] };
  }
  throw new Error("not a relay message");
}
function caFingerprint(pem) {
  return createHash3("sha256").update(new X509Certificate(pem).raw).digest("hex");
}
function checkGrant(grant, advertised) {
  const g = grant;
  if (!g || typeof g.url !== "string" || typeof g.credential !== "string" || !g.credential || typeof g.ca_sha256 !== "string" || typeof g.ca_pem !== "string") return "the lease carries no complete relay grant";
  if (typeof advertised.relay_url !== "string" || typeof advertised.relay_ca_sha256 !== "string") return "the instance does not advertise relay_url and relay_ca_sha256";
  if (advertised.relay_ca_sha256.toLowerCase() !== g.ca_sha256.toLowerCase()) return "the grant names another authority than the instance advertises";
  let fingerprint;
  try {
    fingerprint = caFingerprint(g.ca_pem);
  } catch {
    return "the grant's authority is not a PEM certificate";
  }
  if (fingerprint !== g.ca_sha256.toLowerCase()) return "the grant's authority does not hash to its fingerprint";
  let url;
  try {
    url = new URL(g.url);
  } catch {
    return "the grant's URL does not parse";
  }
  if (url.pathname !== "/relay" || url.username || url.password || url.search || url.hash) return "the grant's URL is not a broker URL at /relay";
  if (url.protocol === "ws:" && !loopback(url.hostname)) return "plain ws:// is accepted only to a loopback host";
  if (url.protocol !== "wss:" && url.protocol !== "ws:") return "the grant's URL is not ws:// or wss://";
  return void 0;
}
function loopback(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || isIP3(host) === 4 && host.startsWith("127.");
}
function stderrLine(line) {
  process.stderr.write(`${line}
`);
}
function webSocketDial(url, caPem, handshakeMs = 1e4, route = {}) {
  const ca = [...rootCertificates, caPem, ...route.caPem ? [route.caPem] : []];
  const resolveTo = route.resolve;
  const lookup = resolveTo ? (hostname, options, callback) => {
    if (hostname.toLowerCase() !== resolveTo.host) return dnsLookup(hostname, options, callback);
    const family = isIP3(resolveTo.address);
    if (options.all) callback(null, [{ address: resolveTo.address, family }]);
    else callback(null, resolveTo.address, family);
  } : void 0;
  return (handlers) => new Promise((resolve4, reject) => {
    const tlsOptions = { ca, ...lookup ? { lookup } : {}, ALPNProtocols: ["http/1.1"], maxPayload: MAX_MESSAGE, perMessageDeflate: false, handshakeTimeout: handshakeMs, followRedirects: false };
    const socket = new wrapper_default(url, [], tlsOptions);
    let open4 = false;
    socket.on("open", () => {
      open4 = true;
      const close = () => {
        if (socket.readyState >= wrapper_default.CLOSING) return;
        socket.close();
        setTimeout(() => socket.terminate(), 1e3).unref();
      };
      resolve4({ send: (data) => socket.send(data, { binary: typeof data !== "string" }), close });
    });
    socket.on("message", (data, binary) => {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      handlers.message(binary ? bytes : bytes.toString("utf8"));
    });
    socket.on("error", (error) => {
      if (!open4) reject(error);
    });
    socket.on("close", (code, reason) => {
      if (!open4) reject(new Error(`closed before opening (${code})`));
      else handlers.closed(`closed (${code}${reason.length ? `: ${reason}` : ""})`);
    });
  });
}
var RelayUncertainError = class extends Error {
  constructor(executionId, message, options) {
    super(`${message}; whether execution ${executionId} took effect is uncertain, and it is not sent again`, options);
    this.executionId = executionId;
    this.name = "RelayUncertainError";
  }
  executionId;
};
var RelayFailedError = class extends Error {
  constructor(executionId, code, detail, committed) {
    super(`relay: ${code}: ${detail}${committed ? `; execution ${executionId} passed its commit point, so whether it took effect is uncertain` : ""}`);
    this.executionId = executionId;
    this.code = code;
    this.detail = detail;
    this.committed = committed;
    this.name = "RelayFailedError";
  }
  executionId;
  code;
  detail;
  committed;
};
var RelayClient = class {
  constructor(grant, options = {}) {
    this.grant = grant;
    this.options = options;
  }
  grant;
  options;
  handle;
  /** The open session's handle, once open; cleared the moment its session ends. */
  active;
  closed = false;
  /** How many sessions this client opened; tests and logs read it. */
  sessions = 0;
  /** The relay agent's description from the current session's `ready`. */
  async ready() {
    return (await this.current()).ready;
  }
  /** Run one operation and wait for its result. A `failed` or `interrupted` outcome is returned, not thrown. */
  async run(op, input = Buffer.alloc(0), options = {}) {
    options.signal?.throwIfAborted();
    const kind = kindOf(op);
    const upload = Buffer.isBuffer(input) ? bufferSource(input) : input;
    if (!uploads(kind) && upload.size) throw new TypeError(`${kind} takes no upload`);
    let executionId = options.executionId ?? randomUUID2();
    if (!executionId || Buffer.byteLength(executionId) > 256) throw new TypeError("an execution ID has 1 to 256 bytes");
    for (let attempt = 0; ; attempt++) {
      const answer = await this.once(op, upload, executionId, options);
      if (reads(kind) && "read" in answer.outcome && !this.streamMatches(answer) && attempt < 3) {
        options.sink?.reset();
        executionId = randomUUID2();
        continue;
      }
      return answer;
    }
  }
  /** What the broker or the relay agent knows of an execution ID (RP-7). */
  async query(executionId, options = {}) {
    const call = this.track(executionId, "status", "query", bufferSource(Buffer.alloc(0)));
    return (await this.dispatch(call, options)).state;
  }
  close() {
    this.closed = true;
    const handle = this.handle;
    this.handle = void 0;
    this.active = void 0;
    void handle?.then((h) => h.session.close(), () => {
    });
  }
  streamMatches(answer) {
    const outcome = answer.outcome;
    return !!answer.stream && !!outcome.read && answer.stream.size === outcome.read.size && answer.stream.sha256 === outcome.read.sha256;
  }
  async once(op, upload, executionId, options) {
    const kind = kindOf(op);
    const call = this.track(executionId, op, kind, upload, options.sink);
    const { result } = await this.dispatch(call, options);
    const id = call.executionId;
    const stream = streams(kind) && (call.end || call.size) ? { size: call.size, sha256: call.hash.copy().digest("hex") } : void 0;
    if (streams(kind) && call.end && stream && (call.end.size !== stream.size || call.end.sha256 !== stream.sha256)) {
      if (!reads(kind)) throw new RelayUncertainError(id, `the output of execution ${id} does not match its end`);
      return { executionId: id, replayed: result.replayed, outcome: result.outcome, output: Buffer.alloc(0) };
    }
    const exit = result.outcome.exit;
    if (exit && stream && (exit.output.size !== stream.size || exit.output.sha256 !== stream.sha256)) throw new RelayUncertainError(id, `the output of execution ${id} does not match its outcome`);
    return { executionId: id, replayed: result.replayed, outcome: result.outcome, output: Buffer.concat(call.kept), ...stream && call.end ? { stream } : {} };
  }
  track(executionId, op, kind, upload, sink) {
    return { executionId, op, kind, upload, sink, hash: createHash3("sha256"), size: 0, kept: [], keptBytes: 0, committedSend: false, resume: false, offset: 0, continuations: 0, wake: [], settle: () => {
    }, fail: () => {
    }, done: false };
  }
  reset(call) {
    call.hash = createHash3("sha256");
    call.size = 0;
    call.kept = [];
    call.keptBytes = 0;
    call.end = void 0;
    call.offset = 0;
    call.sink?.reset();
  }
  /** Wake whoever waits on the call's progress. */
  wakeAll(call) {
    const wake = call.wake;
    call.wake = [];
    for (const go of wake) go();
  }
  /** Wait for the call's next progress, its end, or a second, whichever comes first. */
  nextProgress(call) {
    return new Promise((done) => {
      const timer = setTimeout(done, 1e3);
      timer.unref?.();
      call.wake.push(() => {
        clearTimeout(timer);
        done();
      });
    });
  }
  /** Send a call in the current session and wait for its last message, through any recovery. */
  dispatch(call, options) {
    return new Promise((resolve4, reject) => {
      let timer;
      const finish = () => {
        call.done = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
      };
      call.settle = (answer) => {
        if (call.done) return;
        finish();
        this.wakeAll(call);
        resolve4(answer);
      };
      call.fail = (error) => {
        if (call.done) return;
        finish();
        this.wakeAll(call);
        reject(error);
      };
      const abort = () => {
        const reason = options.signal.reason;
        if (call.kind !== "query" && !reads(call.kind) && call.kind !== "status") void this.cancel(call.executionId);
        call.fail(reason instanceof Error ? reason : new Error(String(reason)));
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.timeoutMs) timer = setTimeout(() => call.fail(call.kind === "query" || reads(call.kind) || call.kind === "status" ? new Error(`relay: no answer for execution ${call.executionId} within ${options.timeoutMs} ms`) : new RelayUncertainError(call.executionId, `no outcome within ${options.timeoutMs} ms; it may still run, and query tells it later`)), options.timeoutMs);
      this.send(call).catch((error) => call.fail(error));
    });
  }
  async cancel(target) {
    try {
      await this.run({ cancel: { target } }, Buffer.alloc(0), { timeoutMs: 3e4 });
    } catch (error) {
      this.options.log?.(`relay: cancelling ${target} failed: ${String(error)}`);
    }
  }
  current() {
    if (this.closed) return Promise.reject(new Error("the relay link is closed"));
    if (!this.handle) {
      const opening = this.openSession();
      this.handle = opening;
      opening.catch(() => {
        if (this.handle === opening) this.handle = void 0;
      });
    }
    return this.handle;
  }
  async openSession() {
    let readyResolve;
    const ready = new Promise((done) => {
      readyResolve = done;
    });
    const handle = { session: void 0, ready, calls: /* @__PURE__ */ new Map(), next: 1 };
    handle.session = await ResumableSession.open({
      dial: this.options.dial ?? webSocketDial(this.grant.url, this.grant.ca_pem, this.options.timing?.handshakeMs, this.options.route ?? brokerRoute()),
      credential: this.grant.credential,
      attributes: { role: "client", protocol: RELAY_PROTOCOL },
      ...this.options.timing ? { timing: this.options.timing } : {},
      ...this.options.random ? { random: this.options.random } : {},
      onBody: (body) => this.receive(handle, body, readyResolve),
      onEnd: (end) => this.ended(handle, end),
      // Every loss and resume goes to the log, by default the server's standard error, so an operator or a test sees the link's history.
      onEvent: (event) => (this.options.log ?? stderrLine)(`relay: session ${event.kind}${event.reason ? `: ${event.reason}` : ""}`)
    });
    this.sessions++;
    if (!handle.session.ended && !this.closed) this.active = handle;
    return handle;
  }
  /**
   * Put a call into the current session: its `call`, its upload as chunks
   * within the window beyond the relay agent's progress, its `end`. A call
   * that resumes waits for the agent's committed offset and sends from there
   * (RP-15).
   */
  async send(call) {
    let handle = await this.current();
    while (handle.session.ended) {
      if (this.active === handle || !this.active) {
        this.active = void 0;
        this.handle = void 0;
      }
      handle = await this.current();
    }
    if (call.done) return;
    const number = handle.next++;
    call.number = number;
    call.committedSend = false;
    call.committed = void 0;
    handle.calls.set(number, call);
    const session = handle.session;
    if (call.kind === "query") {
      session.send(encodeControl("query", { call: number, execution: call.executionId }));
      return;
    }
    const v2 = (await handle.ready).protocol >= 2;
    const stale = () => call.done || session.ended || handle.calls.get(number) !== call;
    if (stale()) return;
    const resume = v2 && call.resume && uploads(call.kind);
    const offset = v2 ? call.offset : 0;
    if (!v2 && call.offset) this.reset(call);
    session.send(encodeControl("call", { call: number, execution: call.executionId, op: call.op, ...resume ? { resume: true } : {}, ...offset ? { offset } : {} }));
    if (!uploads(call.kind)) {
      call.committedSend = true;
      return;
    }
    const { upload } = call;
    let at = 0;
    if (resume) {
      while (call.committed === void 0) {
        if (stale()) return;
        await this.nextProgress(call);
      }
      at = Math.min(call.committed, upload.size);
    }
    const from = at;
    while (at < upload.size) {
      if (v2) while (!stale() && at - (call.committed ?? from) >= UPLOAD_WINDOW) await this.nextProgress(call);
      else await session.drained(MAX_BUFFERED);
      if (stale()) return;
      const length = Math.min(MAX_CHUNK, upload.size - at);
      const data = await upload.read(at, length);
      if (stale()) return;
      session.send(encodeChunk(number, data));
      at += length;
    }
    if (stale()) return;
    session.send(encodeControl("end", { call: number, execution: call.executionId, size: upload.size, sha256: upload.sha256 }));
    call.committedSend = true;
  }
  receive(handle, body, readyResolve) {
    let message;
    try {
      message = decodeMessage(body);
    } catch (error) {
      this.options.log?.(`relay: ignored a body that is not a relay message: ${String(error)}`);
      return;
    }
    if ("chunk" in message) {
      const call2 = handle.calls.get(message.chunk.call);
      if (!call2 || call2.done) return;
      const data = Buffer.from(message.chunk.data);
      call2.hash.update(data);
      call2.size += data.length;
      if (call2.sink) {
        call2.sink.write(data);
        return;
      }
      call2.kept.push(data);
      call2.keptBytes += data.length;
      while (call2.keptBytes > OUTPUT_KEPT && call2.kept.length > 1) call2.keptBytes -= call2.kept.shift().length;
      return;
    }
    const { name, value } = message;
    const call = typeof value?.call === "number" ? handle.calls.get(value.call) : void 0;
    switch (name) {
      case "ready":
        handle.readyInfo = value;
        readyResolve(value);
        return;
      case "pending":
        this.options.log?.(`relay: execution ${value?.execution} waits: ${value?.code}: ${value?.message} (up to ${value?.wait_ms} ms)`);
        return;
      case "end":
        if (call && value.execution === call.executionId) call.end = { size: value.size, sha256: value.sha256 };
        return;
      case "progress":
        if (!call || value.execution !== call.executionId || typeof value.committed !== "number") return;
        call.committed = Math.max(call.committed ?? 0, value.committed);
        this.wakeAll(call);
        return;
      case "result": {
        if (!call || value.execution !== call.executionId) return;
        handle.calls.delete(value.call);
        const failed = value.outcome.failed;
        if (failed?.code === "upload_incomplete" && !failed.committed && uploads(call.kind) && call.continuations < MAX_CONTINUATIONS) {
          call.continuations++;
          call.resume = true;
          this.options.log?.(`relay: execution ${call.executionId} continues from the relay agent's committed offset`);
          this.wakeAll(call);
          void this.send(call).catch((error) => call.fail(error));
          return;
        }
        call.settle({ result: { replayed: !!value.replayed, outcome: value.outcome } });
        return;
      }
      case "query_result":
        if (!call || value.execution !== call.executionId) return;
        handle.calls.delete(value.call);
        call.settle({ state: value.state });
        return;
      case "revoked":
        handle.revoked = String(value?.reason ?? "released");
        return;
      default:
        return;
    }
  }
  /**
   * The session ended for good. A local close or a refusal fails every call
   * that was out; any other end opens a new session and recovers each call
   * from the records (RP-7).
   */
  ended(handle, end) {
    if (!handle) return;
    if (this.active === handle) {
      this.active = void 0;
      this.handle = void 0;
    }
    const calls = [...handle.calls.values()].filter((call) => !call.done);
    handle.calls.clear();
    const why = end.kind === "rejected" ? `the broker refused the session (${end.code}: ${end.message})` : end.kind === "closed" ? handle.revoked ? `the lease was ${handle.revoked}` : end.byPeer ? "the broker closed the session" : "the relay link was closed" : end.kind === "expired" ? `the session expired (${end.reason})` : `the session broke (${end.message})`;
    this.options.log?.(`relay: ${why}`);
    const final = this.closed || end.kind === "rejected" || end.kind === "closed";
    for (const call of calls) {
      this.wakeAll(call);
      if (final) {
        call.fail(this.mayHaveRun(call) ? new RelayUncertainError(call.executionId, `relay: ${why}`) : new Error(`relay: ${why}; the operation never reached its commit point`));
        continue;
      }
      void this.recover(call).catch((error) => call.fail(error));
    }
  }
  /** Whether a call may have passed its commit point: its upload's `end`, or for cancel its `call`, went out. */
  mayHaveRun(call) {
    if (call.kind === "query" || reads(call.kind) || call.kind === "status" || call.number === void 0) return false;
    return call.committedSend || !uploads(call.kind);
  }
  /** After an unresumable loss: query, then attach to a known execution, or report it uncertain. */
  async recover(call) {
    if (call.done) return;
    if (reads(call.kind) && !call.end) {
      call.executionId = randomUUID2();
      call.offset = call.size;
      return this.send(call);
    }
    this.reset(call);
    if (uploads(call.kind) && !call.committedSend && call.number !== void 0) {
      call.resume = true;
      return this.send(call);
    }
    if (!this.mayHaveRun(call)) {
      if (reads(call.kind)) call.executionId = randomUUID2();
      return this.send(call);
    }
    let state;
    try {
      state = await this.query(call.executionId);
    } catch (error) {
      throw new RelayUncertainError(call.executionId, `the session was lost and the execution could not be queried: ${error.message}`, { cause: error });
    }
    if (state === "unknown") throw new RelayUncertainError(call.executionId, "the session was lost and neither the broker nor the relay agent has a record of the execution");
    if (call.done) return;
    call.resume = true;
    return this.send(call);
  }
};

// src/machine-service.ts
function machineServiceFromProcess(env = process.env, environment = selectedEnvironment(env), settings = {}) {
  const baseUrl = serviceUrl(env, environment);
  return new MachineService(environment ? { ...settings, baseUrl, environment } : { ...settings, baseUrl });
}
var MachineServiceError = class extends Error {
  constructor(message, status, responseBody, options) {
    super(message, options);
    this.status = status;
    this.responseBody = responseBody;
    this.name = "MachineServiceError";
  }
  status;
  responseBody;
  /** The host is at capacity, such as its limit on running macOS VMs: nothing was reserved, and the same acquisition may be asked again (DC-22). */
  capacity = false;
};
function capacityRefusal(error) {
  if (!(error instanceof MachineServiceError) || error.status !== 409 || !error.responseBody) return false;
  let body;
  try {
    body = JSON.parse(error.responseBody);
  } catch {
    return false;
  }
  if (!body || typeof body !== "object") return false;
  const { error: reason, outcome } = body;
  return typeof reason === "string" && /^(macOS VM limit reached|durable machine leased|durable machine unavailable)/.test(reason) && outcome !== "uncertain";
}
var SERVICE_NAME = "machine-service";
function expectMachineService(health, origin) {
  if (health.service === SERVICE_NAME) return;
  throw new Error(`The service at ${origin} answers as ${JSON.stringify(health.service ?? null)}, not ${SERVICE_NAME}. This relay speaks only machine-service's /machines API: install machine-service, which replaced vm-service.`);
}
var PULL_IDLE_MS = 12e4;
var AcquireIndeterminateError = class extends MachineServiceError {
  constructor(purpose, cause) {
    super(`Acquisition outcome unknown for purpose '${purpose}'; reconcile GET /machines before retrying or ending the enclosure`, void 0, void 0, { cause });
    this.purpose = purpose;
    this.name = "AcquireIndeterminateError";
  }
  purpose;
};
function positive(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) throw new TypeError(`${label} must be a positive bounded integer`);
  return value;
}
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function named(value) {
  const fields = value;
  if (record(value) && fields.kind === "durable" && typeof fields.vm !== "string" && typeof fields.name === "string") fields.vm = fields.name;
  return value;
}
function isLease(value) {
  if (!record(value)) return false;
  if (named(value).kind === "durable") {
    return ["vm", "purpose", "lease_id", "workspace"].every((k) => typeof value[k] === "string" && value[k] !== "") && value.image === null && value.image_kind === null && value.state === "leased" && ["created_at", "ttl_expires_at"].every((k) => typeof value[k] === "number" && Number.isFinite(value[k]));
  }
  return ["vm", "purpose", "image"].every((k) => typeof value[k] === "string" && value[k] !== "") && ["macos", "linux"].includes(String(value.image_kind)) && ["pending", "provisioning", "running", "releasing"].includes(String(value.state)) && ["created_at", "ttl_expires_at"].every((k) => typeof value[k] === "number" && Number.isFinite(value[k])) && ["cpu", "memory_mb", "disk_gb", "grace_until"].every((k) => value[k] === null || typeof value[k] === "number") && ["env", "ip"].every((k) => value[k] === null || typeof value[k] === "string") && typeof value.warned === "boolean";
}
function shellQuote(value) {
  if (value && /^[A-Za-z0-9@%_\-+=:,./]+$/.test(value)) return value;
  if (!value) return "''";
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
function tailChars(text, max) {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(chars.length - max).join("");
}
var MachineService = class {
  baseUrl;
  /** Leases whose operations go through the broker, by machine name (docs/relay-agent-link.md §3). */
  relays = /* @__PURE__ */ new Map();
  relayOptions;
  environment;
  timeoutMs;
  acquireTimeoutMs;
  maxResponseBytes;
  transport;
  constructor(options) {
    if (typeof options === "string") options = { baseUrl: options };
    this.environment = options.environment;
    this.transport = options.transport ?? ((url2, init) => fetch(url2, init));
    const named2 = options.baseUrl ?? options.environment?.profile.vmServiceUrl;
    if (named2 === void 0) throw new TypeError("machine-service client needs its origin: a baseUrl or a selected environment");
    const url = new URL(named2);
    if (options.environment && url.origin !== new URL(options.environment.profile.vmServiceUrl).origin) throw new TypeError("Backend endpoint does not match the selected environment");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const loopback2 = host === "localhost" || host === "::1" || isIP4(host) === 4 && host.startsWith("127.");
    if (!loopback2 && !options.listed || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new TypeError("machine-service baseUrl must be a loopback HTTP(S) origin, or one discovery found, without credentials, path, query or fragment");
    }
    this.baseUrl = url.origin;
    this.timeoutMs = positive(options.timeoutMs ?? 66e4, "timeoutMs");
    this.acquireTimeoutMs = positive(options.acquireTimeoutMs ?? 36e5, "acquireTimeoutMs");
    this.maxResponseBytes = positive(options.maxResponseBytes ?? 4 * 1024 * 1024, "maxResponseBytes");
    this.relayOptions = options.relay;
  }
  /**
   * Route a lease's guest operations through the broker when its record says
   * `link: relay` and it carries the acquisition's grant; any other lease,
   * `ssh-fallback` included, keeps the HTTP operations (§6).
   */
  useRelay(vm, lease) {
    const known = this.relays.get(vm);
    if (lease.link === "relay" && lease.relay) {
      if (known && known.grant.credential === lease.relay.credential) return;
      this.dropRelay(vm);
      this.relays.set(vm, { grant: lease.relay });
      return;
    }
    this.dropRelay(vm);
  }
  /** Whether a lease's operations go through the broker: the grant matches what the instance advertises. */
  async relayLink(vm) {
    return !!await this.relayFor(vm);
  }
  dropRelay(vm) {
    const route = this.relays.get(vm);
    this.relays.delete(vm);
    void route?.checked?.then((client) => client?.close(), () => {
    });
  }
  relayFor(vm) {
    const route = this.relays.get(vm);
    if (!route) return Promise.resolve(void 0);
    route.checked ??= (async () => {
      const health = await this.request("/health", void 0, { timeoutMs: 1e4 });
      const refused = checkGrant(route.grant, health);
      if (refused) return void 0;
      return new RelayClient(route.grant, this.relayOptions);
    })();
    route.checked.catch(() => {
      if (this.relays.get(vm) === route) route.checked = void 0;
    });
    return route.checked;
  }
  /** One operation through the broker, its `failed` and `interrupted` outcomes as errors. */
  async relayRun(client, op, upload, executionId, options) {
    let answer;
    try {
      answer = await client.run(op, upload, { executionId, ...options.signal ? { signal: options.signal } : {}, ...options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}, ...options.sink ? { sink: options.sink } : {} });
    } catch (cause) {
      if (options.signal?.aborted && cause === options.signal.reason) throw cause;
      throw new MachineServiceError(`machine-service relay link: ${cause.message}`, void 0, void 0, { cause });
    }
    const outcome = answer.outcome;
    if (outcome.failed) {
      const failure = new RelayFailedError(answer.executionId, outcome.failed.code, outcome.failed.message, outcome.failed.committed);
      throw new MachineServiceError(failure.message, void 0, void 0, { cause: failure });
    }
    if (outcome.interrupted) {
      const failure = new RelayUncertainError(answer.executionId, `relay: the relay agent stopped while the operation ran: ${outcome.interrupted.message}`);
      throw new MachineServiceError(failure.message, void 0, void 0, { cause: failure });
    }
    return answer;
  }
  health(options = {}) {
    return this.request("/health", void 0, options);
  }
  async list(options = {}) {
    const list = await this.request("/machines", void 0, options);
    if (record(list.machines)) Object.values(list.machines).forEach(named);
    return list;
  }
  images(options = {}) {
    return this.request("/images", void 0, options);
  }
  applications(options = {}) {
    return this.request("/applications", void 0, options);
  }
  acquisitionCapabilities(options = {}) {
    return this.consoleRequest("/acquisition-capabilities", void 0, options);
  }
  consoleResolve(vm, body, options = {}) {
    return this.consoleRequest(this.path(vm, "console/resolve"), body, options);
  }
  consoleOpen(vm, body, options = {}) {
    return this.consoleRequest(this.path(vm, "console/open"), body, options);
  }
  consoleCancel(vm, body, options = {}) {
    return this.consoleRequest(this.path(vm, "console/cancel"), body, options);
  }
  async consoleRequest(path, body, options) {
    try {
      return await this.request(path, body, options);
    } catch (error) {
      throw new MachineServiceError(`Console API unavailable or request outcome unknown${error instanceof MachineServiceError && error.status ? ` (HTTP ${error.status})` : ""}; resolve before another open`, error instanceof MachineServiceError ? error.status : void 0);
    }
  }
  async get(vm, options = {}) {
    const path = this.path(vm) + (options.lease_id ? `?${new URLSearchParams({ lease_id: options.lease_id })}` : "");
    return named(await this.request(path, void 0, options));
  }
  /**
   * Cancellation before dispatch prevents allocation. Once dispatched we deliberately
   * do NOT abort the request: return the lease even if the caller cancels, so its
   * finally/cleanup path can register and release it. Caller must track the returned
   * lease before checking its signal. Network loss/deadline remains indeterminate
   * (a daemon protocol limitation); never blindly retry acquisition.
   */
  async acquire(body, options = {}) {
    options.signal?.throwIfAborted();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(body.purpose)) throw new TypeError("Invalid VM purpose");
    const timeoutMs = positive(options.timeoutMs ?? this.acquireTimeoutMs, "timeoutMs");
    try {
      const lease = await this.request("/acquire", body, { timeoutMs });
      if (!isLease(lease)) throw new MachineServiceError("Invalid machine-service acquire response");
      this.useRelay(lease.vm, lease);
      return lease;
    } catch (error) {
      const safeError = body.vnc ? new MachineServiceError(`VNC acquisition refused or outcome unknown${error instanceof MachineServiceError && error.status ? ` (HTTP ${error.status})` : ""}; inspect capabilities and reconcile ownership`, error instanceof MachineServiceError ? error.status : void 0) : error;
      if (safeError instanceof MachineServiceError) safeError.capacity = capacityRefusal(error);
      if (error instanceof MachineServiceError && error.status !== void 0 && error.status >= 400 && error.status < 500) throw safeError;
      throw new AcquireIndeterminateError(body.purpose, safeError);
    }
  }
  /**
   * On a `relay` lease the command runs through the broker in the desktop
   * session, under the request's execution ID, and answers as machine-service's
   * own relay route does; otherwise one HTTP request.
   */
  exec(vm, body, options = {}) {
    this.path(vm);
    return this.execRouted(vm, body, options);
  }
  async execRouted(vm, body, options) {
    const client = await this.relayFor(vm);
    if (!client) return this.request(this.path(vm, "exec"), body, options);
    const timeout = body.timeout ?? 600;
    if (!(timeout > 0)) throw new MachineServiceError("timeout must be positive");
    const executionId = body.execution_id ?? randomUUID3();
    const [op, upload] = body.script !== void 0 ? [{ script: { timeout_s: timeout } }, Buffer.from(body.script)] : [{ exec: { command: body.argv.map(shellQuote).join(" "), stdin: false, timeout_s: timeout } }, Buffer.alloc(0)];
    const answer = await this.relayRun(client, op, upload, executionId, { ...options, timeoutMs: options.timeoutMs ?? this.timeoutMs });
    const exit = answer.outcome.exit;
    if (!exit) throw new MachineServiceError(`machine-service relay link: unexpected outcome ${JSON.stringify(answer.outcome)}`);
    if (exit.timed_out) throw new MachineServiceError(`machine-service relay link: the command timed out after ${timeout}s and was killed`);
    return { vm, rc: exit.rc ?? 255, output: tailChars(answer.output.toString("utf8"), 64e3), link: "relay", execution_id: answer.executionId };
  }
  /** On a `relay` lease a file goes as a `write` through the broker; a folder still goes over HTTP, as machine-service sends folders by `scp` (DC-151). */
  push(vm, body, options = {}) {
    this.path(vm);
    return this.pushRouted(vm, body, options);
  }
  async pushRouted(vm, body, options) {
    const client = await this.relayFor(vm);
    const facts = client ? await stat(body.local_path) : void 0;
    if (!client || !facts?.isFile()) return this.request(this.path(vm, "push"), body, options);
    const source = await fileSource(body.local_path);
    const answer = await this.relayRun(client, { write: { path: body.remote_path, name: basename(body.local_path), mode: facts.mode & 511 } }, source, randomUUID3(), { ...options, timeoutMs: options.timeoutMs ?? this.timeoutMs });
    const written = answer.outcome.written;
    if (!written || written.size !== source.size || written.sha256 !== source.sha256) throw new MachineServiceError(`machine-service relay link: the relay agent wrote ${JSON.stringify(answer.outcome)}, not what was sent`);
    return { vm, pushed: body.local_path, to: body.remote_path };
  }
  /** On a `relay` lease a file comes as a `read` through the broker, checked and renamed into place; a guest folder still goes over HTTP. */
  pull(vm, body, options = {}) {
    this.path(vm);
    return this.pullRouted(vm, body, options);
  }
  async pullRouted(vm, body, options) {
    const client = await this.relayFor(vm);
    if (!client) return this.request(this.path(vm, "pull"), body, options);
    const part = `${body.local_path}.relay-${randomUUID3()}.part`;
    try {
      await this.relayRead(client, body.remote_path, part, options);
    } catch (error) {
      await rm(part, { force: true });
      if (error.cause?.code === "is_directory") return this.request(this.path(vm, "pull"), body, options);
      throw error;
    }
    await rename(part, body.local_path);
    return { vm, pulled: body.remote_path, to: body.local_path };
  }
  /** Read a guest file into `to`, which must not exist, streaming and hashing it; the bytes must match the read's outcome. */
  async relayRead(client, remote, to, options) {
    const file = await open2(to, "wx", 384);
    let position = 0, writing = Promise.resolve();
    const sink = {
      write: (data) => {
        const at = position;
        position += data.length;
        writing = writing.then(() => file.write(data, 0, data.length, at));
      },
      reset: () => {
        position = 0;
        writing = writing.then(() => file.truncate(0));
      }
    };
    try {
      const answer = await this.relayRun(client, { read: { path: remote } }, Buffer.alloc(0), randomUUID3(), { ...options, timeoutMs: options.timeoutMs ?? this.timeoutMs, sink });
      await writing;
      const read = answer.outcome.read;
      if (!read || !answer.stream || answer.stream.size !== read.size || answer.stream.sha256 !== read.sha256 || position !== read.size) throw new MachineServiceError(`machine-service relay link: the bytes of ${remote} do not match their SHA-256; pull again`);
      await file.sync();
      return { sha256: read.sha256, bytes: read.size };
    } finally {
      await writing.catch(() => {
      });
      await file.close();
    }
  }
  async heartbeat(vm, body = {}, options = {}) {
    return named(await this.request(this.path(vm, "heartbeat"), body, options));
  }
  release(vm, body = {}, options = {}) {
    this.dropRelay(vm);
    return this.request(this.path(vm, "release"), body, options);
  }
  /**
   * Push one file as bytes, `PUT /machines/<name>/files` (FD-4): the instance
   * checks the digest before it writes, so a client on another Mac needs no
   * host path the instance could read (DC-31).
   */
  async pushBytes(vm, body, options = {}) {
    const sha256 = createHash4("sha256").update(body.bytes).digest("hex");
    const client = await this.relayFor(vm);
    if (client) {
      const answer2 = await this.relayRun(client, { write: { path: body.remote_path, name: "", mode: null } }, body.bytes, randomUUID3(), { ...options, timeoutMs: options.timeoutMs ?? this.timeoutMs });
      const written = answer2.outcome.written;
      if (!written || written.sha256 !== sha256 || written.size !== body.bytes.length) throw new MachineServiceError(`machine-service relay link: the relay agent wrote ${JSON.stringify(answer2.outcome)}, not what was sent`);
      return { sha256, bytes: body.bytes.length };
    }
    const response = await this.fetchBounded(this.filesPath(vm, body.remote_path, body.lease_id), { method: "PUT", headers: { "Content-Type": "application/octet-stream", "X-Content-SHA256": sha256 }, body: new Uint8Array(body.bytes.buffer, body.bytes.byteOffset, body.bytes.byteLength) }, options, this.maxResponseBytes);
    const answer = this.json(response.path, response.text);
    if (answer.sha256 !== sha256 || answer.bytes !== body.bytes.length) throw new MachineServiceError(`machine-service ${response.path}: the instance stored ${answer.bytes} bytes with SHA-256 ${answer.sha256}, not what was sent`);
    return answer;
  }
  /**
   * Pull one file as bytes, `GET /machines/<name>/files`, into `to`, which
   * must not exist. The bytes stream to disk as they are hashed, so a file of
   * any size needs no memory of its size, and the pull is abandoned only when
   * no byte arrives for its timeout. The file is removed unless the bytes
   * match the digest the instance states (DC-31).
   */
  async pullBytes(vm, body, options = {}) {
    const client = await this.relayFor(vm);
    if (client) {
      try {
        return await this.relayRead(client, body.remote_path, body.to, options);
      } catch (error) {
        await rm(body.to, { force: true });
        throw error;
      }
    }
    const hash2 = createHash4("sha256"), file = await open2(body.to, "wx", 384);
    let bytes = 0;
    try {
      const response = await this.fetchBounded(this.filesPath(vm, body.remote_path, body.lease_id), { method: "GET" }, { ...options, timeoutMs: options.timeoutMs ?? PULL_IDLE_MS }, Number.MAX_SAFE_INTEGER, { idle: true, sink: async (chunk) => {
        hash2.update(chunk);
        bytes += chunk.byteLength;
        await file.write(chunk);
      } });
      if (response.contentType !== "application/octet-stream") throw new MachineServiceError(`machine-service ${response.path}: expected one file, got ${response.contentType ?? "no content type"}`);
      const digest = hash2.digest("hex");
      if (!response.sha256 || digest !== response.sha256.toLowerCase()) throw new MachineServiceError(`machine-service ${response.path}: the bytes' SHA-256 ${digest} differs from the stated ${response.sha256 ?? "none"}`);
      await file.sync();
      await file.close();
      return { sha256: digest, bytes };
    } catch (error) {
      await file.close().catch(() => {
      });
      await rm(body.to, { force: true });
      throw error;
    }
  }
  filesPath(vm, remote, lease_id) {
    const query = new URLSearchParams({ ...lease_id ? { lease_id } : {}, path: remote });
    return `${this.path(vm, "files")}?${query}`;
  }
  path(vm, action) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(vm)) throw new TypeError("Invalid VM name");
    return `/machines/${encodeURIComponent(vm)}${action ? `/${action}` : ""}`;
  }
  async request(path, body, options) {
    const response = await this.fetchBounded(path, {
      method: body === void 0 ? "GET" : "POST",
      headers: body === void 0 ? {} : { "Content-Type": "application/json" },
      ...body === void 0 ? {} : { body: JSON.stringify(body) }
    }, options, this.maxResponseBytes);
    return this.json(path, response.text);
  }
  json(path, text) {
    try {
      return JSON.parse(text);
    } catch (cause) {
      throw new MachineServiceError(`machine-service ${path}: invalid JSON response`, void 0, void 0, { cause });
    }
  }
  /**
   * One request whose answer is read up to `maxBytes`; an error answer is read
   * up to 4 KiB and thrown with its status. With `sink`, a successful answer is
   * handed over chunk by chunk instead of kept; with `idle`, the timeout counts
   * from the last chunk rather than from the start.
   */
  async fetchBounded(path, init, options, maxBytes, stream = {}) {
    options.signal?.throwIfAborted();
    const timeoutMs = positive(options.timeoutMs ?? this.timeoutMs, "timeoutMs");
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    const expire = () => controller.abort(Object.assign(new MachineServiceError(`machine-service ${path} timed out after ${timeoutMs}ms${stream.idle ? " without a byte" : ""}`), { code: "ETIMEDOUT" }));
    let timer = setTimeout(expire, timeoutMs);
    try {
      const response = await this.transport(`${this.baseUrl}${path}`, {
        method: init.method,
        headers: { ...init.headers, ...this.environment ? { "X-VM-Environment-Fingerprint": this.environment.identity.fingerprint } : {} },
        ...init.body === void 0 ? {} : { body: init.body },
        signal: controller.signal,
        redirect: "error"
        // Do not let a service redirect to another host.
      });
      const reader = response.body?.getReader();
      const chunks = [];
      let size = 0;
      const bound = response.ok ? maxBytes : Math.min(4096, maxBytes);
      let truncated = false;
      if (reader) {
        try {
          for (; ; ) {
            const { value, done } = await reader.read();
            if (done) break;
            if (stream.idle) {
              clearTimeout(timer);
              timer = setTimeout(expire, timeoutMs);
            }
            if (response.ok && stream.sink) {
              size += value.byteLength;
              await stream.sink(value);
              continue;
            }
            const remaining = bound - size;
            chunks.push(value.subarray(0, remaining));
            size += Math.min(value.byteLength, remaining);
            if (value.byteLength > remaining) {
              truncated = true;
              await reader.cancel();
              break;
            }
          }
        } finally {
          reader.releaseLock();
        }
      }
      const bytes = Buffer.concat(chunks), text = bytes.toString("utf8");
      if (!response.ok) throw new MachineServiceError(`machine-service ${path}: HTTP ${response.status}: ${text}${truncated ? " [truncated]" : ""}`, response.status, text);
      if (truncated) throw new MachineServiceError(`machine-service ${path}: response exceeds ${bound} bytes`);
      return { path, bytes, text, contentType: response.headers.get("content-type") ?? void 0, sha256: response.headers.get("x-content-sha256") ?? void 0 };
    } catch (cause) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (cause instanceof MachineServiceError) throw cause;
      throw new MachineServiceError(`machine-service ${path}: request failed${cause instanceof Error ? `: ${cause.message}` : ""}`, void 0, void 0, { cause });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }
};

// src/registry.ts
import { randomUUID as randomUUID4 } from "node:crypto";
import { link, lstat, mkdir, open as open3, readFile, realpath, rename as rename2, unlink } from "node:fs/promises";
import { readFileSync as readFileSync3, statSync as statSync2 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { spawn as spawn2 } from "node:child_process";
import { dirname as dirname2, join as join3, resolve as resolve3 } from "node:path";
var RegistryError = class extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "RegistryError";
  }
};
var columns = ["machine", "os", "taskName", "agent", "project", "startDate"];
function cells(row) {
  return columns.map((key) => {
    const value = row[key];
    if (typeof value !== "string" || !value.trim() || value !== value.trim() || /[|\r\n\u0000-\u001f\u007f]/.test(value)) {
      throw new RegistryError(`Registry ${key} must be nonempty trimmed text without pipes or control characters`);
    }
    return value;
  });
}
function parse(line) {
  const text = line.trim();
  if (!text.startsWith("|") || !text.endsWith("|")) return void 0;
  return text.slice(1, -1).split("|").map((cell) => cell.trim());
}
function linesOf(text) {
  const lines = [];
  const pattern = /[^\r\n]*(?:\r\n|\n|\r|$)/g;
  for (const match of text.matchAll(pattern)) {
    if (!match[0]) continue;
    lines.push({ text: match[0].replace(/[\r\n]+$/, ""), start: match.index, end: match.index + match[0].length });
  }
  return lines;
}
function table(text) {
  const lines = linesOf(text);
  const sections = lines.map((line, index) => /^## Using VMs\s*$/.test(line.text) ? index : -1).filter((index) => index >= 0);
  if (sections.length !== 1) throw new RegistryError("Expected exactly one '## Using VMs' section");
  const begin = sections[0];
  let end = lines.findIndex((line, index) => index > begin && /^#{1,2} /.test(line.text));
  if (end < 0) end = lines.length;
  const headers = lines.map((line, index) => index > begin && index < end && JSON.stringify(parse(line.text)) === JSON.stringify(["Machine", "OS", "Task Name", "Agent", "Project", "Start Date"]) ? index : -1).filter((index) => index >= 0);
  if (headers.length !== 1) throw new RegistryError("Expected exactly one VM task registry table");
  const header = headers[0];
  const separator = lines[header + 1];
  const separatorCells = separator && parse(separator.text);
  if (!separatorCells || separatorCells.length !== 6 || !separatorCells.every((cell) => /^:?-{2,}:?$/.test(cell))) {
    throw new RegistryError("Malformed VM task registry separator");
  }
  const rows = [];
  for (let i = header + 2; i < end && lines[i].text.trim().startsWith("|"); i++) {
    const line = lines[i];
    if (parse(line.text)?.length !== 6) throw new RegistryError("Malformed VM task registry row");
    rows.push(line);
  }
  const last = rows.at(-1) ?? separator;
  return { rows, insertion: last.end, newline: text.includes("\r\n") ? "\r\n" : "\n" };
}
function validateRegistryText(text) {
  table(text);
}
function resolveRegistry(options = {}) {
  const env = options.env ?? process.env;
  const root = options.managedRoot ?? selectedEnvironment(env, options.home)?.profile.relayStateDir;
  if (root !== void 0 && options.path === void 0) return { path: join3(absolute(root, "managed registry root"), "registry.md"), managed: true };
  const explicit = options.path ?? env.MCP_RELAY_REGISTRY;
  const validate = (path) => {
    if (!statSync2(path).isFile()) throw new RegistryError("Registry target must be a regular file");
    table(readFileSync3(path, "utf8"));
  };
  if (explicit !== void 0) {
    const path = options.path !== void 0 ? resolve3(nonblank(explicit, "Registry path")) : absolute(explicit, "MCP_RELAY_REGISTRY");
    validate(path);
    return { path, managed: false };
  }
  const legacy = join3(options.home ?? env.HOME ?? homedir3(), "AGENTS.md");
  try {
    validate(legacy);
    return { path: resolve3(legacy), managed: false };
  } catch (error) {
    if (!(error instanceof RegistryError) && !errno(error, "ENOENT") && !errno(error, "ENOTDIR")) throw error;
  }
  return { path: join3(relayStateRoot(options), "registry.md"), managed: true };
}
var REGISTRY_LOCK_SUFFIX = ".mcp-vm-relay.lock";
var MANAGED_REGISTRY = `# mcp-relay task registry

## Using VMs

| Machine | OS | Task Name | Agent | Project | Start Date |
| ------- | -- | --------- | ----- | ------- | ---------- |
`;
function errno(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}
function bounded(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) throw new TypeError(`${label} must be a positive bounded integer`);
  return value;
}
var FLOCK_HELPER = `
import fcntl, os, select, sys, time
fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
deadline = time.monotonic() + float(sys.argv[2])
while True:
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        break
    except BlockingIOError:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            sys.stderr.write("registry lock timeout")
            sys.exit(2)
        readable, _, _ = select.select([sys.stdin], [], [], min(float(sys.argv[3]), remaining))
        if readable:
            sys.exit(3)
print("locked", flush=True)
sys.stdin.buffer.read()
os.close(fd)
`;
var Registry = class {
  path;
  managed;
  lockTimeoutMs;
  lockRetryMs;
  pythonExecutable;
  constructor(options = {}) {
    if (typeof options === "string") options = { path: options };
    const registry = resolveRegistry(options);
    this.path = registry.path;
    this.managed = registry.managed;
    this.lockTimeoutMs = bounded(options.lockTimeoutMs ?? 1e4, "lockTimeoutMs");
    this.lockRetryMs = bounded(options.lockRetryMs ?? 25, "lockRetryMs");
    this.pythonExecutable = options.pythonExecutable === void 0 ? pythonExecutable(options.env) : nonblank(options.pythonExecutable, "pythonExecutable");
  }
  /** Returns false when this exact row is already registered (idempotent). */
  async add(row, options = {}) {
    const desired = cells(row);
    return this.update((text) => {
      const registry = table(text);
      const matching = registry.rows.filter((line) => parse(line.text)[2] === row.taskName);
      if (matching.length > 0) {
        if (matching.length === 1 && JSON.stringify(parse(matching[0].text)) === JSON.stringify(desired)) return text;
        throw new RegistryError(`Task '${row.taskName}' is already registered by a different owner or duplicated`);
      }
      const prefix = registry.insertion > 0 && !/[\r\n]/.test(text[registry.insertion - 1]) ? registry.newline : "";
      const added = `${prefix}| ${desired.join(" | ")} |${registry.newline}`;
      return text.slice(0, registry.insertion) + added + text.slice(registry.insertion);
    }, options.signal);
  }
  /** Returns false when absent. Never removes a row whose ownership differs. */
  async remove(row, options = {}) {
    const desired = cells(row);
    return this.update((text) => {
      const registry = table(text);
      const matching = registry.rows.filter((line2) => parse(line2.text)[2] === row.taskName);
      if (matching.length === 0) return text;
      if (matching.length !== 1 || JSON.stringify(parse(matching[0].text)) !== JSON.stringify(desired)) {
        throw new RegistryError(`Refusing to remove task '${row.taskName}': ownership does not match`);
      }
      const line = matching[0];
      return text.slice(0, line.start) + text.slice(line.end);
    }, options.signal);
  }
  async update(transform, signal) {
    signal?.throwIfAborted();
    if (this.managed) {
      await mkdir(dirname2(this.path), { recursive: true, mode: 448 });
      const parent = await lstat(dirname2(this.path));
      if (!parent.isDirectory()) throw new RegistryError("Managed registry parent must be a directory, not a symlink");
      if ((parent.mode & 63) !== 0) throw new RegistryError("Managed registry parent must be private (0700); choose a private state directory. Existing directory permissions are not changed automatically.");
    }
    const target = this.managed ? join3(await realpath(dirname2(this.path)), "registry.md") : await realpath(this.path);
    const lock = await this.lock(`${target}${REGISTRY_LOCK_SUFFIX}`, signal);
    const token = randomUUID4();
    let temporary;
    try {
      signal?.throwIfAborted();
      if (this.managed) await this.initialize(target, lock.check);
      const before = await lstat(target);
      if (!before.isFile()) throw new RegistryError("Registry target must be a regular file");
      const original = await readFile(target, "utf8");
      const updated = transform(original);
      if (original === updated) return false;
      temporary = join3(dirname2(target), `.${target.split("/").at(-1)}.${token}.tmp`);
      const handle = await open3(temporary, "wx", before.mode & 511);
      try {
        await handle.chmod(before.mode & 511);
        await handle.writeFile(updated, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      signal?.throwIfAborted();
      const current = await lstat(target);
      if (current.ino !== before.ino || current.mtimeMs !== before.mtimeMs || await readFile(target, "utf8") !== original) {
        throw new RegistryError("Registry changed outside its lock; retry without overwriting those changes");
      }
      lock.check();
      await rename2(temporary, target);
      temporary = void 0;
      const dir = await open3(dirname2(target), "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
      return true;
    } finally {
      try {
        if (temporary) await unlink(temporary).catch((error) => {
          if (!errno(error, "ENOENT")) throw error;
        });
      } finally {
        await lock.release();
      }
    }
  }
  /** Publish a complete initial table without replacing any existing path.
   * Called only under the same cooperative lock used by all row updates. */
  async initialize(target, check) {
    try {
      await lstat(target);
      return;
    } catch (error) {
      if (!errno(error, "ENOENT")) throw error;
    }
    const temporary = join3(dirname2(target), `.registry.${randomUUID4()}.tmp`);
    const handle = await open3(temporary, "wx", 384);
    try {
      try {
        await handle.chmod(384);
        await handle.writeFile(MANAGED_REGISTRY, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      check();
      try {
        await link(temporary, target);
      } catch (error) {
        if (!errno(error, "EEXIST")) throw error;
      }
      const dir = await open3(dirname2(target), "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } finally {
      await unlink(temporary);
    }
  }
  async lock(path, signal) {
    signal?.throwIfAborted();
    const child = spawn2(this.pythonExecutable, ["-u", "-c", FLOCK_HELPER, path, String(this.lockTimeoutMs / 1e3), String(this.lockRetryMs / 1e3)], { stdio: ["pipe", "pipe", "pipe"] });
    let closed = false;
    const exit = new Promise((resolveExit) => child.once("close", () => {
      closed = true;
      resolveExit();
    }));
    child.stdin.on("error", () => {
    });
    let failure;
    let acquired = false;
    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr = (stderr + String(data)).slice(0, 4096);
    });
    const abort = () => {
      failure = signal?.reason;
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      failure = new RegistryError(`Timed out waiting for registry lock ${path}`);
      child.kill("SIGTERM");
    }, this.lockTimeoutMs + 1e3);
    try {
      await new Promise((resolveReady, rejectReady) => {
        let output = "";
        child.stdout.on("data", (data) => {
          output += String(data);
          if (output === "locked\n") {
            acquired = true;
            resolveReady();
          } else if (output.length > 100) {
            failure = new RegistryError("Invalid registry lock helper response");
            child.kill("SIGTERM");
          }
        });
        child.once("error", (error) => {
          failure = new RegistryError("Cannot start Python flock helper", { cause: error });
        });
        child.once("close", () => {
          if (!acquired) rejectReady(failure ?? new RegistryError(`Registry lock helper exited: ${stderr || "no ready response"}`));
        });
      });
    } catch (error) {
      child.stdin.end();
      await exit;
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
    const check = () => {
      if (closed || child.exitCode !== null || child.signalCode !== null) throw new RegistryError("Registry lock helper died during update; lock ownership was lost");
    };
    return { check, release: async () => {
      check();
      child.stdin.end();
      await exit;
    } };
  }
};

// src/doctor.ts
async function installationReport(options = {}) {
  const checks = [];
  const check = async (name, fn) => {
    try {
      checks.push({ name, ok: true, detail: await fn() });
    } catch (e) {
      checks.push({ name, ok: false, detail: String(e) });
    }
  };
  const environment = selectedEnvironment();
  const run = options.run ?? command;
  const assets = options.assetsDir ?? fileURLToPath(new URL("../dist/", import.meta.url));
  await check("node", async () => {
    if (Number(process.versions.node.split(".")[0]) < 22) throw Error("Install Node.js 22 or newer.");
    return process.versions.node;
  });
  const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch, local = localTartHost(platform, arch);
  await check("host", async () => {
    if (environment && !local) throw Error("The supported local Tart/machine-service backend requires an Apple-silicon Mac. Ubuntu is a guest, not a substitute host.");
    return local ? `${platform}/${arch}` : `${platform}/${arch}: no local Tart backend; the relay leases from a machine-service instance on another host`;
  });
  await check("python", async () => {
    const r = await run([pythonExecutable(), "-c", "import fcntl, sys; print(sys.version.split()[0])"], { timeoutMs: 5e3 });
    if (r.code !== 0) throw Error("Install Python 3 with fcntl, or set MCP_RELAY_PYTHON to its executable. " + r.stderr);
    return r.stdout.trim();
  });
  await check("runtime-bundles", async () => {
    const integrity = JSON.parse(await readFile2(join4(assets, "integrity.json"), "utf8"));
    for (const name of ["server.mjs", "receiver.mjs", "doctor.mjs"]) {
      const b = await readFile2(join4(assets, name));
      if (hash(b) !== integrity[name]) throw Error(`Invalid/missing shipped ${name}; reinstall the package.`);
    }
    return "Host extension, guest receiver and doctor hashes verified";
  });
  await check("registry", async () => {
    const registry = options.registry ?? new Registry(environment ? { managedRoot: environment.profile.relayStateDir } : {});
    try {
      await access(registry.path);
      validateRegistryText(await readFile2(registry.path, "utf8"));
      return `Existing registry: ${registry.path}`;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      if (process.env.MCP_RELAY_REGISTRY) throw Error("MCP_RELAY_REGISTRY must point to an existing Using VMs registry table.");
      return `Managed registry will be created on first acquisition: ${registry.path}`;
    }
  });
  await check("tart", async () => {
    if (!local && !environment) return "Not used on this host: destruction is verified in the remote instance's /machines inventory";
    const r = await run([environment?.profile.tartPath ?? "tart", "list", "--format", "json"], { timeoutMs: 1e4, ...environment ? { env: { ...process.env, ...environmentVariables(environment) } } : {} });
    if (r.code !== 0 || !Array.isArray(JSON.parse(r.stdout))) throw Error("Install Tart and ensure tart list --format json works; required for independent destruction verification.");
    return "Read-only local inventory available";
  });
  await check("machine-service", async () => {
    const vm = options.vm ?? machineServiceFromProcess(process.env, environment);
    const health = await vm.health({ timeoutMs: 5e3 });
    if (!health.ok) throw Error("Service health check failed");
    expectMachineService(health, vm.baseUrl);
    if (environment && !matchesEnvironment(health.environment, environment)) throw Error("machine-service environment identity mismatch");
    const images = await vm.images({ timeoutMs: 5e3 });
    await vm.list({ timeoutMs: 5e3 });
    const available = Object.entries(images.images).filter(([, v]) => v.base_available).map(([k]) => k);
    if (!available.length) throw Error("machine-service is running but has no available golden images. Provision a supported image in the backend.");
    return `HTTP API reachable; available images: ${available.join(", ")}. This inventory does not prove guest readiness. Use relay probe scope=guest for executable checks; capture and browser behavior require separate checks. Staging alone is not readiness.`;
  });
  return { formatVersion: 1, ready: checks.every((c) => c.ok), environment: environment?.identity, stateDirectory: environment?.profile.relayStateDir ?? relayStateRoot(), checks, note: "Read-only host/API prerequisite check. No VM acquired, input sent, screenshot captured or permissions changed. Claude Code (or another MCP client) must be installed separately." };
}
if (process.argv[1] && pathToFileURL(realpathSync2(process.argv[1])).href === import.meta.url) {
  try {
    const r = await installationReport();
    console.log(JSON.stringify(r, null, 2));
    process.exitCode = r.ready ? 0 : 1;
  } catch (e) {
    console.log(JSON.stringify({ ready: false, error: String(e), hint: "Check MCP_RELAY_* configuration and installation paths." }, null, 2));
    process.exitCode = 1;
  }
}
export {
  installationReport
};
