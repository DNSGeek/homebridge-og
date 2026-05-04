function OpenGarageModule(
  log,
  config,
  { Service, Characteristic, openGarageApi, setTimeout, clearTimeout, Date },
) {
  const openCloseDurationMs =
    (config.openCloseDurationSecs ||
      OpenGarageModule.defaults.openCloseDurationSecs) * 1000;
  const pollFrequencyMs =
    (config.pollFrequencySecs || OpenGarageModule.defaults.pollFrequencySecs) *
    1000;
  const vehicleSensorName =
    config.vehicleSensorName || OpenGarageModule.defaults.vehicleSensorName;

  function after(ms, result) {
    return new Promise((resolve) => setTimeout(() => resolve(result), ms));
  }

  class OpenGarage {
    constructor(name) {
      this.name = name;
      this.currentState = { error: "Successful poll not yet completed" };
      this.lastTarget = undefined;

      this.garageService = new Service.GarageDoorOpener(this.name);

      this.garageService
        .getCharacteristic(Characteristic.CurrentDoorState)
        .onGet(() => this.getState());

      this.garageService
        .getCharacteristic(Characteristic.TargetDoorState)
        .onGet(() => this.targetDoorState())
        .onSet((value) => this.changeState(value));

      this.garageService
        .getCharacteristic(Characteristic.ObstructionDetected)
        .onGet(() => this.getStateObstruction());

      this.vehicleService = new Service.OccupancySensor(vehicleSensorName);

      this.vehicleService
        .getCharacteristic(Characteristic.OccupancyDetected)
        .onGet(() => this.getVehicleOccupancy());

      this.pollStateRefreshLoop();
    }

    getStateObstruction() {
      return false;
    }

    getVehicleOccupancy() {
      log(
        "Status vehicle: %s",
        this.currentVehicleState() ? "present" : "not present",
      );
      return this.currentVehicleState();
    }

    getState() {
      log("Getting current state asynchronously...");
      this.triggerStateRefresh().then(
        (isClosed) => log("Status garage: %s", isClosed ? "closed" : "open"),
        (err) => log("Error getting state: %s", err.message),
      );
      return this.currentDoorState();
    }

    isClosed() {
      if (this.currentState.success)
        return this.currentState.success.door === 0;
      throw new Error("Last poll failed - " + this.lastErrorMessage());
    }

    isVehiclePresent() {
      if (this.currentState.success)
        return this.currentState.success.vehicle === 1;
      throw new Error("Last poll failed - " + this.lastErrorMessage());
    }

    lastErrorMessage() {
      const e = this.currentState.error;
      if (!e) return "unknown";
      if (e instanceof Error) return e.message;
      return String(e);
    }

    targetDoorState() {
      if (
        !this.lastTarget ||
        Date.now() - this.lastTarget.ts >= openCloseDurationMs
      ) {
        if (this.isClosed()) return Characteristic.TargetDoorState.CLOSED;
        return Characteristic.TargetDoorState.OPEN;
      }
      if (this.lastTarget.closed) return Characteristic.TargetDoorState.CLOSED;
      return Characteristic.TargetDoorState.OPEN;
    }

    currentDoorState() {
      if (this.isClosed()) return Characteristic.CurrentDoorState.CLOSED;
      return Characteristic.CurrentDoorState.OPEN;
    }

    currentVehicleState() {
      if (this.isVehiclePresent())
        return Characteristic.OccupancyDetected.OCCUPANCY_DETECTED;
      return Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED;
    }

    triggerStateRefresh() {
      return openGarageApi.getState().then(
        (state) => {
          this.currentState = { success: state };
          this.notify();
          log.debug(
            "Poll status garage: %s",
            this.isClosed() ? "closed" : "open",
          );
          return this.isClosed();
        },
        (error) => {
          this.currentState = { error: error };
          throw error;
        },
      );
    }

    pollStateRefreshLoop() {
      if (this.pollTimer) clearTimeout(this.pollTimer);
      this.pollTimer = setTimeout(
        () => this.pollStateRefreshLoop(),
        pollFrequencyMs,
      );

      this.triggerStateRefresh().catch((err) => {
        log("Error polling state:", err.message);
      });
    }

    notify() {
      this.garageService
        .getCharacteristic(Characteristic.CurrentDoorState)
        .updateValue(this.currentDoorState());
      this.garageService
        .getCharacteristic(Characteristic.TargetDoorState)
        .updateValue(this.targetDoorState());
      this.vehicleService
        .getCharacteristic(Characteristic.OccupancyDetected)
        .updateValue(this.currentVehicleState());
    }

    async changeState(state) {
      const targetStateClosed = state === Characteristic.TargetDoorState.CLOSED;
      log("Set state to %s", targetStateClosed ? "closed" : "open");

      try {
        await openGarageApi.setTargetState(targetStateClosed);
      } catch (err) {
        log("Error changing state:", err.message);
        throw err;
      }

      log("Target state successfully received.");
      this.lastTarget = {
        ts: Date.now(),
        closed: targetStateClosed,
      };

      after(openCloseDurationMs)
        .then(() => this.triggerStateRefresh())
        .catch((err) => log("Error refreshing after change:", err.message));
    }
  }

  return OpenGarage;
}
OpenGarageModule.defaults = {
  openCloseDurationSecs: 25,
  pollFrequencySecs: 60,
  vehicleSensorName: "Vehicle Present",
};
module.exports = OpenGarageModule;
