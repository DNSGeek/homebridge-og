const OpenGarageModule = require("./lib/open_garage.js");
const OpenGarageApiModule = require("./lib/open_garage_api.js");

module.exports = function (homebridge) {
  const Service = homebridge.hap.Service;
  const Characteristic = homebridge.hap.Characteristic;

  class OpenGarageConnect {
    constructor(log, config) {
      // Ensure log.debug exists (older Homebridge versions may not have it)
      if (!log.debug) {
        log.debug = (...args) => log(...args);
      }

      const OpenGarageApi = OpenGarageApiModule(log);
      const openGarageApi = new OpenGarageApi({
        ip: config.ip,
        key: config.key,
      });
      const OpenGarage = OpenGarageModule(log, config, {
        Service,
        Characteristic,
        openGarageApi,
        setTimeout,
        clearTimeout,
        Date,
      });
      this.openGarage = new OpenGarage(config.name, true);
    }

    getServices() {
      return [this.openGarage.garageService, this.openGarage.vehicleService];
    }
  }

  // Compatible with Homebridge v1.6+ and v2.x
  homebridge.registerAccessory(
    "homebridge-og",
    "OpenGarage",
    OpenGarageConnect,
  );
};
