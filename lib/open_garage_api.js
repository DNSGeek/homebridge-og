const http = require("http");

function OpenGarageApiModule(log) {
  class OpenGarageApi {
    constructor({ ip, key, requestTimeoutMs }) {
      this.key = key;
      this.baseUrl = "http://" + ip;
      this.timeoutMs =
        Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0
          ? requestTimeoutMs
          : 10000;
    }

    urlFor(path, params) {
      let url = this.baseUrl + path + "?dkey=" + encodeURIComponent(this.key);
      if (params) url = url + "&" + params;
      return url;
    }

    _httpGet(url) {
      return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => resolve(data));
        });
        req.setTimeout(this.timeoutMs, () => {
          req.destroy(new Error(`Request timed out after ${this.timeoutMs}ms`));
        });
        req.on("error", (err) => {
          log("HTTP error:", err.message);
          reject(err);
        });
      });
    }

    getState() {
      return this._httpGet(this.urlFor("/jc")).then(
        (body) => {
          try {
            return JSON.parse(body);
          } catch (err) {
            throw new Error("Invalid JSON from device: " + err.message);
          }
        },
        (err) => {
          log("Error getting state:", err.message);
          throw err;
        },
      );
    }

    _handleResponse(body) {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (err) {
        throw new Error("Invalid JSON from device: " + err.message);
      }
      switch (parsed.result) {
        case 1:
          return true;
        case 2:
          throw new Error("Not authorized");
        case 3:
          throw new Error("Mismatch");
        case 16:
          throw new Error("Data missing");
        case 17:
          throw new Error("Out of range");
        case 18:
          throw new Error("Data Format Error");
        case 32:
          throw new Error("Page Not Found");
        case 48:
          throw new Error("Not Permitted");
        case 64:
          throw new Error("Upload Failed");
        default:
          throw new Error("Unrecognized response code: " + parsed.result);
      }
    }

    setTargetState(closed) {
      const url = this.urlFor("/cc", closed ? "close=1" : "open=1");
      log.debug
        ? log.debug("Sending command: %s", closed ? "close" : "open")
        : log("Sending command: %s", closed ? "close" : "open");
      return this._httpGet(url).then((body) => this._handleResponse(body));
    }
  }

  return OpenGarageApi;
}
module.exports = OpenGarageApiModule;
