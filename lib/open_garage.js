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
  const errorThreshold =
    Number.isFinite(config.errorThreshold) && config.errorThreshold > 0
      ? config.errorThreshold
      : OpenGarageModule.defaults.errorThreshold;
  const rebootRetryIntervalMs =
    (config.rebootRetryIntervalSecs ||
      OpenGarageModule.defaults.rebootRetryIntervalSecs) * 1000;
  const stateDebounceMs =
    (Number.isFinite(config.stateDebounceSecs) && config.stateDebounceSecs >= 0
      ? config.stateDebounceSecs
      : OpenGarageModule.defaults.stateDebounceSecs) * 1000;

  function after(ms, result) {
    return new Promise((resolve) => setTimeout(() => resolve(result), ms));
  }

  class OpenGarage {
    constructor(name) {
      this.name = name;
      this.currentState = { error: "Successful poll not yet completed" };
      this.lastTarget = undefined;
      this.reportedClosed = null;
      this.pendingClosed = null;
      this.pendingSince = null;
      this.pendingSamples = 0;
      this.consecutiveErrors = 0;
      this.rebootTimer = null;
      this.lastNotified = new Map();

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

    // Debounced view of door state to filter transient sensor glitches.
    isReportedClosed() {
      if (this.reportedClosed !== null) return this.reportedClosed;
      return this.isClosed();
    }

    updateReportedDoorState() {
      if (!this.currentState.success) return;
      const newClosed = this.currentState.success.door === 0;

      if (this.reportedClosed === null) {
        this.reportedClosed = newClosed;
        this.clearPendingDoorState();
        return;
      }

      if (newClosed === this.reportedClosed) {
        this.clearPendingDoorState();
        return;
      }

      const now = Date.now();
      if (this.pendingClosed !== newClosed) {
        this.pendingClosed = newClosed;
        this.pendingSince = now;
        this.pendingSamples = 0;
      }
      this.pendingSamples += 1;

      // A change we just asked for is trusted immediately. Anything else has to
      // hold for stateDebounceMs across at least two reads before HomeKit hears
      // about it. The elapsed-time check matters because polls are not the only
      // source of readings - every HomeKit read triggers one too, so a burst of
      // reads during a momentary sensor glitch would otherwise "confirm" itself
      // within a second and produce a closed/open notification pair.
      const userInitiated =
        this.lastTarget &&
        this.lastTarget.closed === newClosed &&
        now - this.lastTarget.ts < openCloseDurationMs * 4;
      const settled =
        this.pendingSamples >= 2 && now - this.pendingSince >= stateDebounceMs;

      if (userInitiated || settled) {
        this.reportedClosed = newClosed;
        this.clearPendingDoorState();
      }
    }

    clearPendingDoorState() {
      this.pendingClosed = null;
      this.pendingSince = null;
      this.pendingSamples = 0;
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
        if (this.isReportedClosed())
          return Characteristic.TargetDoorState.CLOSED;
        return Characteristic.TargetDoorState.OPEN;
      }
      if (this.lastTarget.closed) return Characteristic.TargetDoorState.CLOSED;
      return Characteristic.TargetDoorState.OPEN;
    }

    currentDoorState() {
      if (this.isReportedClosed())
        return Characteristic.CurrentDoorState.CLOSED;
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
          this.consecutiveErrors = 0;
          if (this.rebootTimer) {
            clearTimeout(this.rebootTimer);
            this.rebootTimer = null;
            log("Device is back online. Reboot retry loop cancelled.");
          }
          this.currentState = { success: state };
          this.updateReportedDoorState();
          this.notify();
          log.debug(
            "Poll status garage: %s",
            this.isClosed() ? "closed" : "open",
          );
          return this.isClosed();
        },
        (error) => {
          this.currentState = { error: error };
          this.consecutiveErrors++;
          if (this.consecutiveErrors >= errorThreshold && !this.rebootTimer) {
            log(
              "Device unreachable after %d consecutive errors. Starting reboot retry loop.",
              this.consecutiveErrors,
            );
            this.scheduleReboot();
          }
          throw error;
        },
      );
    }

    scheduleReboot() {
      this.rebootTimer = setTimeout(() => {
        this.rebootTimer = null;
        log("Attempting to reboot device...");
        openGarageApi
          .reboot()
          .then(() => {
            log(
              "Reboot command accepted. Waiting for device to come back online.",
            );
            // Don't schedule another reboot - the normal poll loop will detect
            // recovery and cancel the reboot state via consecutiveErrors reset.
          })
          .catch((err) => {
            log("Reboot attempt failed: %s - will retry.", err.message);
            // Device still unreachable; schedule another attempt.
            if (this.consecutiveErrors >= errorThreshold) {
              this.scheduleReboot();
            }
          });
      }, rebootRetryIntervalMs);
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

    // Pushing a value HomeKit already has still counts as an event, and every
    // poll and every HomeKit read lands here - so only push actual changes.
    updateIfChanged(service, characteristic, value) {
      if (this.lastNotified.get(characteristic) === value) return;
      this.lastNotified.set(characteristic, value);
      service.getCharacteristic(characteristic).updateValue(value);
    }

    notify() {
      this.updateIfChanged(
        this.garageService,
        Characteristic.CurrentDoorState,
        this.currentDoorState(),
      );
      this.updateIfChanged(
        this.garageService,
        Characteristic.TargetDoorState,
        this.targetDoorState(),
      );
      this.updateIfChanged(
        this.vehicleService,
        Characteristic.OccupancyDetected,
        this.currentVehicleState(),
      );
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
  errorThreshold: 5,
  rebootRetryIntervalSecs: 30,
  stateDebounceSecs: 60,
};
module.exports = OpenGarageModule;
