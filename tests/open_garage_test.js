const assert = require("assert");
const OpenGarageModule = require("../lib/open_garage.js");

// ─── Mock HAP classes ────────────────────────────────────────────────────────

class MockDevice {
  constructor(name) {
    this.name = name;
    this.characteristics = {};
  }
  getCharacteristic(characteristic) {
    if (!(characteristic.name in this.characteristics))
      this.characteristics[characteristic.name] = new MockCharacteristic(
        characteristic,
      );
    return this.characteristics[characteristic.name];
  }
  setCharacteristic(characteristic, value) {
    this.characteristics[characteristic.name] = value;
    return this;
  }
}

class MockCharacteristic {
  constructor(char) {
    this.name = char.name;
    this.characteristic = char;
    this._getHandler = null;
    this._setHandler = null;
  }

  onGet(handler) {
    this._getHandler = handler;
    return this;
  }

  onSet(handler) {
    this._setHandler = handler;
    return this;
  }

  async triggerGet() {
    return await this._getHandler();
  }

  triggerGetSync() {
    // Synchronous helper: handler returns immediately for non-async sources.
    const result = this._getHandler();
    if (result && typeof result.then === "function") {
      throw new Error("Handler returned a Promise; use triggerGet()");
    }
    return result;
  }

  async triggerSetAsync(value) {
    return await this._setHandler(value);
  }

  updateValue(value) {
    this.value = value;
    this.updates = (this.updates || 0) + 1;
  }
}

class GarageDoorOpener extends MockDevice {}
class OccupancySensor extends MockDevice {}

const MockHomebridge = {
  hap: {
    uuid: { generate: (input) => input },
    Service: { GarageDoorOpener, OccupancySensor },
    Characteristic: {
      Manufacturer: { name: "Manufacturer" },
      Model: { name: "Model" },
      SerialNumber: { name: "SerialNumber" },
      TargetDoorState: {
        name: "TargetDoorState",
        CLOSED: "T_CLOSED",
        OPEN: "T_OPEN",
      },
      CurrentDoorState: {
        name: "CurrentDoorState",
        CLOSED: "CLOSED",
        OPEN: "OPEN",
      },
      ObstructionDetected: { name: "ObstructionDetected" },
      OccupancyDetected: {
        name: "OccupancyDetected",
        OCCUPANCY_DETECTED: "OCCUPIED",
        OCCUPANCY_NOT_DETECTED: "NOT_OCCUPIED",
      },
    },
  },
};

// ─── Mock logger ─────────────────────────────────────────────────────────────

function MockLog(...args) {
  console.log(...args);
}
MockLog.debug = console.log;

// ─── Helper: poll until assertion passes or deadline exceeded ─────────────────

function eventually(fn) {
  const deadline = Date.now() + 1000;
  return new Promise((success, reject) => {
    const timer = setInterval(() => {
      try {
        success(fn());
        clearInterval(timer);
      } catch (err) {
        if (Date.now() > deadline) {
          clearInterval(timer);
          reject(err);
        }
      }
    }, 5);
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("OpenGarage", function () {
  let openGarage;
  let mockOpenGarageApi;
  let MockSetTimeout;
  let MockClearTimeout;
  let MockDate;
  let currentDoorState;
  let targetDoorState;

  const pollFrequencyMs = OpenGarageModule.defaults.pollFrequencySecs * 1000;
  const openDurationMs = OpenGarageModule.defaults.openCloseDurationSecs * 1000;
  const debounceMs = OpenGarageModule.defaults.stateDebounceSecs * 1000;

  const Characteristic = MockHomebridge.hap.Characteristic;
  const Service = MockHomebridge.hap.Service;

  class MockOpenGarageApi {
    constructor() {
      this.isClosed = false;
    }
    getState() {
      return Promise.resolve({ door: this.isClosed ? 0 : 1 });
    }
    setTargetState(closed) {
      this.targetClosedState = closed;
      return Promise.resolve(true);
    }
  }

  beforeEach(() => {
    let timers = [];
    let timerIdx = 0;

    MockSetTimeout = function (fn, duration) {
      timerIdx += 1;
      const timer = { idx: timerIdx, fn, duration };
      timers.push(timer);
      return timer;
    };
    MockClearTimeout = function (timer) {
      if (!timer) return;
      const arrayIdx = timers.findIndex((t) => t.idx === timer.idx);
      if (arrayIdx !== -1) timers.splice(arrayIdx, 1);
    };
    MockSetTimeout.getTimers = () => timers;
    MockSetTimeout.invoke = ({ idx }) => {
      const timer = timers.find((t) => t.idx === idx);
      MockClearTimeout(timer);
      timer.fn();
    };
    MockSetTimeout.clear = () => {
      timers = [];
    };

    MockDate = {
      currentTime: 1529629810000,
      now: () => MockDate.currentTime,
    };

    mockOpenGarageApi = new MockOpenGarageApi();

    const OpenGarage = OpenGarageModule(
      MockLog,
      {},
      {
        openGarageApi: mockOpenGarageApi,
        Service: Service,
        Characteristic: Characteristic,
        setTimeout: MockSetTimeout,
        clearTimeout: MockClearTimeout,
        Date: MockDate,
      },
    );

    mockOpenGarageApi.isClosed = true;
    openGarage = new OpenGarage("garage");
    currentDoorState = openGarage.garageService.getCharacteristic(
      Characteristic.CurrentDoorState,
    );
    targetDoorState = openGarage.garageService.getCharacteristic(
      Characteristic.TargetDoorState,
    );
  });

  // Let any promise callbacks queued by a refresh settle.
  function flush() {
    return new Promise((resolve) => setImmediate(resolve));
  }

  // Advance the mock clock, then run the scheduled poll.
  async function poll(advanceMs) {
    MockDate.currentTime += advanceMs || 0;
    MockSetTimeout.invoke(openGarage.pollTimer);
    await flush();
  }

  // Advance the mock clock, then read the characteristic the way HomeKit does,
  // which kicks off an out-of-band refresh.
  async function homeKitRead(advanceMs) {
    MockDate.currentTime += advanceMs || 0;
    const value = currentDoorState.triggerGetSync();
    await flush();
    return value;
  }

  describe("#constructor", () => {
    it("throws an error if no successful poll has happened yet", async () => {
      // Replace mock to fail and construct a fresh accessory so the
      // constructor's initial poll fails too.
      mockOpenGarageApi.getState = () =>
        Promise.reject(new Error("HTTP ERROR"));
      const FailingOpenGarage = OpenGarageModule(
        MockLog,
        {},
        {
          openGarageApi: mockOpenGarageApi,
          Service: Service,
          Characteristic: Characteristic,
          setTimeout: MockSetTimeout,
          clearTimeout: MockClearTimeout,
          Date: MockDate,
        },
      );
      const failing = new FailingOpenGarage("garage");
      const failingDoorState = failing.garageService.getCharacteristic(
        Characteristic.CurrentDoorState,
      );
      MockSetTimeout.invoke(failing.pollTimer);
      await eventually(() => {
        assert.throws(() => failingDoorState.triggerGetSync());
      });
    });

    it("keeps reporting the last known state when a poll transiently fails", async () => {
      MockSetTimeout.invoke(openGarage.pollTimer);
      await eventually(() => assert.equal(openGarage.isClosed(), true));

      // After at least one good poll, transient errors should not flip the
      // reported state to "unknown" — HomeKit keeps seeing the cached value.
      mockOpenGarageApi.getState = () =>
        Promise.reject(new Error("HTTP ERROR"));
      MockSetTimeout.invoke(openGarage.pollTimer);
      await eventually(() =>
        assert.equal(
          currentDoorState.triggerGetSync(),
          Characteristic.CurrentDoorState.CLOSED,
        ),
      );
    });

    it("polls the status and propagates values to Home", async () => {
      MockSetTimeout.invoke(openGarage.pollTimer);
      await eventually(() => assert.equal(openGarage.isClosed(), true));

      assert.equal(
        Characteristic.CurrentDoorState.CLOSED,
        currentDoorState.value,
      );
      assert.equal(
        Characteristic.TargetDoorState.CLOSED,
        targetDoorState.value,
      );

      // First poll seeing the new state arms the debounce but does not yet
      // propagate the change to HomeKit.
      const pollTimer = openGarage.pollTimer;
      mockOpenGarageApi.isClosed = false;
      await poll(pollFrequencyMs);

      assert.notEqual(pollTimer, openGarage.pollTimer);

      assert.equal(openGarage.isClosed(), false);
      assert.equal(
        Characteristic.CurrentDoorState.CLOSED,
        currentDoorState.value,
      );

      // A confirming poll once the debounce window has elapsed propagates the
      // change.
      await poll(debounceMs);

      assert.equal(
        Characteristic.CurrentDoorState.OPEN,
        currentDoorState.value,
      );
      assert.equal(Characteristic.TargetDoorState.OPEN, targetDoorState.value);
    });

    it("ignores a single transient sensor glitch", async () => {
      // Two polls a debounce window apart settle the reported state to OPEN.
      mockOpenGarageApi.isClosed = false;
      await poll(pollFrequencyMs);
      await poll(debounceMs);
      assert.equal(
        Characteristic.CurrentDoorState.OPEN,
        currentDoorState.value,
      );

      // One bad poll reports closed — must not propagate.
      mockOpenGarageApi.isClosed = true;
      await poll(pollFrequencyMs);
      assert.equal(openGarage.isClosed(), true);
      assert.equal(
        Characteristic.CurrentDoorState.OPEN,
        currentDoorState.value,
      );

      // Reading recovers to open — still open in HomeKit, no flicker.
      mockOpenGarageApi.isClosed = false;
      await poll(pollFrequencyMs);
      assert.equal(openGarage.isClosed(), false);
      assert.equal(
        Characteristic.CurrentDoorState.OPEN,
        currentDoorState.value,
      );
    });

    it("ignores a glitch confirmed only by a burst of rapid reads", async () => {
      mockOpenGarageApi.isClosed = false;
      await poll(pollFrequencyMs);
      await poll(debounceMs);
      assert.equal(
        Characteristic.CurrentDoorState.OPEN,
        currentDoorState.value,
      );

      // HomeKit reads trigger refreshes too, so several readings can land
      // within a few seconds of each other. A glitch shorter than the debounce
      // window must not confirm itself no matter how often it is sampled.
      mockOpenGarageApi.isClosed = true;
      for (let i = 0; i < 5; i++) await homeKitRead(1000);
      assert.equal(
        Characteristic.CurrentDoorState.OPEN,
        currentDoorState.value,
      );

      mockOpenGarageApi.isClosed = false;
      await homeKitRead(1000);
      assert.equal(
        Characteristic.CurrentDoorState.OPEN,
        currentDoorState.value,
      );
    });

    it("does not re-notify HomeKit while the state is unchanged", async () => {
      await poll(pollFrequencyMs);
      const doorUpdates = currentDoorState.updates;
      const targetUpdates = targetDoorState.updates;

      await poll(pollFrequencyMs);
      await poll(pollFrequencyMs);
      await homeKitRead(1000);

      assert.equal(currentDoorState.updates, doorUpdates);
      assert.equal(targetDoorState.updates, targetUpdates);
    });

    it("sends the command to open the garage door and polls after duration", async () => {
      await targetDoorState.triggerSetAsync(
        Characteristic.TargetDoorState.OPEN,
      );

      assert.equal(mockOpenGarageApi.targetClosedState, false);
      assert.equal(
        openGarage.currentDoorState(),
        Characteristic.CurrentDoorState.CLOSED,
      );
      assert.equal(
        openGarage.targetDoorState(),
        Characteristic.TargetDoorState.OPEN,
      );

      const [pollTimer, afterTimer] = MockSetTimeout.getTimers();
      assert.equal(pollTimer.duration, pollFrequencyMs);
      assert.equal(afterTimer.duration, openDurationMs);

      mockOpenGarageApi.isClosed = false;
      MockDate.currentTime += openDurationMs;
      MockSetTimeout.invoke(afterTimer);

      await eventually(() => {
        assert.equal(mockOpenGarageApi.targetClosedState, false);
        assert.equal(
          openGarage.currentDoorState(),
          Characteristic.CurrentDoorState.OPEN,
        );
        assert.equal(
          openGarage.targetDoorState(),
          Characteristic.TargetDoorState.OPEN,
        );
      });
    });

    it("reverts the target door state if the door does not change within openDurationMs", async () => {
      await targetDoorState.triggerSetAsync(
        Characteristic.TargetDoorState.OPEN,
      );

      assert.equal(mockOpenGarageApi.targetClosedState, false);
      assert.equal(
        openGarage.currentDoorState(),
        Characteristic.CurrentDoorState.CLOSED,
      );
      assert.equal(
        openGarage.targetDoorState(),
        Characteristic.TargetDoorState.OPEN,
      );

      const [pollTimer, afterTimer] = MockSetTimeout.getTimers();
      assert.equal(pollTimer.duration, pollFrequencyMs);
      assert.equal(afterTimer.duration, openDurationMs);

      MockSetTimeout.invoke(afterTimer);

      await eventually(() => {
        assert.equal(mockOpenGarageApi.targetClosedState, false);
        assert.equal(
          openGarage.currentDoorState(),
          Characteristic.CurrentDoorState.CLOSED,
        );
        assert.equal(
          openGarage.targetDoorState(),
          Characteristic.TargetDoorState.OPEN,
        );
      });

      MockDate.currentTime += openDurationMs;
      assert.equal(
        openGarage.targetDoorState(),
        Characteristic.TargetDoorState.CLOSED,
      );
    });
  });
});
