const assert = require('assert')
const OpenGarageModule = require("../lib/open_garage.js")

// ─── Mock HAP classes ────────────────────────────────────────────────────────

class MockDevice {
    constructor(name) {
        this.name = name
        this.characteristics = {}
    }
    getCharacteristic(characteristic) {
        if (!(characteristic.name in this.characteristics))
            this.characteristics[characteristic.name] = new MockCharacteristic(characteristic)
        return this.characteristics[characteristic.name]
    }
    setCharacteristic(characteristic, value) {
        this.characteristics[characteristic.name] = value
        return this
    }
}

class MockCharacteristic {
    constructor(char) {
        this.name = char.name
        this.characteristic = char
        this._on = {}
    }

    on(key, fn) {
        this._on[key] = fn
        return this
    }

    triggerGetSync() {
        let result
        this._on['get']((err, r) => {
            if (err) throw err
            result = r
        })
        return result
    }

    triggerSetAsync(value) {
        return new Promise((accept, reject) => {
            this._on['set'](value, (err) => {
                if (err != null)
                    reject(err)
                else
                    accept()
            })
        })
    }

    updateValue(value) {
        this.value = value
    }
}

class GarageDoorOpener extends MockDevice {}
class OccupancySensor extends MockDevice {}

const MockHomebridge = {
    hap: {
        uuid: { generate: (input) => input },
        Service: { GarageDoorOpener, OccupancySensor },
        Characteristic: {
            Manufacturer:         { name: "Manufacturer" },
            Model:                { name: "Model" },
            SerialNumber:         { name: "SerialNumber" },
            TargetDoorState:      { name: "TargetDoorState",     CLOSED: "T_CLOSED", OPEN: "T_OPEN" },
            CurrentDoorState:     { name: "CurrentDoorState",    CLOSED: "CLOSED",   OPEN: "OPEN" },
            ObstructionDetected:  { name: "ObstructionDetected" },
            OccupancyDetected:    { name: "OccupancyDetected",
                                    OCCUPANCY_DETECTED: "OCCUPIED",
                                    OCCUPANCY_NOT_DETECTED: "NOT_OCCUPIED" },
        }
    }
}

// ─── Mock logger (fixed: was calling this.console.log which doesn't exist) ───

function MockLog(...args) {
    console.log(...args)
}
MockLog.debug = console.log

// ─── Helper: poll until assertion passes or deadline exceeded ─────────────────

function eventually(fn) {
    let deadline = Date.now() + 1000
    return new Promise((success, reject) => {
        let timer = setInterval(() => {
            try {
                success(fn())
                clearInterval(timer)
            } catch(err) {
                if (Date.now() > deadline) {
                    clearInterval(timer)
                    reject(err)
                }
            }
        }, 5)
    })
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('OpenGarage', function() {
    let openGarage
    let mockOpenGarageApi
    let MockSetTimeout
    let MockClearTimeout
    let MockDate
    let currentDoorState
    let targetDoorState

    // Reference ms values directly from module defaults (converted from secs)
    const pollFrequencyMs  = OpenGarageModule.defaults.pollFrequencySecs      * 1000
    const openDurationMs   = OpenGarageModule.defaults.openCloseDurationSecs  * 1000

    const Characteristic = MockHomebridge.hap.Characteristic
    const Service        = MockHomebridge.hap.Service

    class MockOpenGarageApi {
        constructor() {
            this.isClosed = false
        }
        getState() {
            return Promise.resolve({ door: this.isClosed ? 0 : 1 })
        }
        setTargetState(closed) {
            this.targetClosedState = closed
            return Promise.resolve(true)
        }
    }

    beforeEach(() => {
        let timers = []
        let timerIdx = 0

        MockSetTimeout = function(fn, duration) {
            timerIdx += 1
            let timer = { idx: timerIdx, fn, duration }
            timers.push(timer)
            return timer
        }
        MockClearTimeout = function(timer) {
            if (!timer) return
            let arrayIdx = timers.findIndex((t) => t.idx === timer.idx)
            if (arrayIdx !== -1)
                timers.splice(arrayIdx, 1)
        }
        MockSetTimeout.getTimers  = () => timers
        MockSetTimeout.invoke     = ({ idx }) => {
            let timer = timers.find((t) => t.idx === idx)
            MockClearTimeout(timer)
            timer.fn()
        }
        MockSetTimeout.clear      = () => { timers = [] }

        MockDate = {
            currentTime: 1529629810000,
            now: () => MockDate.currentTime
        }

        mockOpenGarageApi = new MockOpenGarageApi()

        let OpenGarage = OpenGarageModule(MockLog, {}, {
            openGarageApi: mockOpenGarageApi,
            Service:        Service,
            Characteristic: Characteristic,
            setTimeout:     MockSetTimeout,
            clearTimeout:   MockClearTimeout,
            Date:           MockDate
        })

        mockOpenGarageApi.isClosed = true
        openGarage       = new OpenGarage("garage", true)
        currentDoorState = openGarage.garageService.getCharacteristic(Characteristic.CurrentDoorState)
        targetDoorState  = openGarage.garageService.getCharacteristic(Characteristic.TargetDoorState)
    })

    describe('#constructor', () => {

        it('throws an error if last poll result was an error', async () => {
            mockOpenGarageApi.getState = () => Promise.reject(new Error("HTTP ERROR"))
            MockSetTimeout.invoke(openGarage.pollTimer)
            await eventually(() => {
                assert.throws(() => currentDoorState.triggerGetSync())
            })
        })

        it('polls the status and propagates values to Home', async () => {
            MockSetTimeout.invoke(openGarage.pollTimer)
            await eventually(() => assert.equal(openGarage.isClosed(), true))

            assert.equal(Characteristic.CurrentDoorState.CLOSED, currentDoorState.value)
            assert.equal(Characteristic.TargetDoorState.CLOSED,  targetDoorState.value)

            let pollTimer = openGarage.pollTimer
            mockOpenGarageApi.isClosed = false
            MockSetTimeout.invoke(pollTimer)

            // a new poll timer should be scheduled
            assert.notEqual(pollTimer, openGarage.pollTimer)

            // when api call resolves these should be updated
            await eventually(() => {
                assert.equal(openGarage.isClosed(), false)
                assert.equal(Characteristic.CurrentDoorState.OPEN, currentDoorState.value)
                assert.equal(Characteristic.TargetDoorState.OPEN,  targetDoorState.value)
            })
        })

        it('sends the command to open the garage door and polls after duration', async () => {
            // Garage starts closed; request to open
            await targetDoorState.triggerSetAsync(Characteristic.TargetDoorState.OPEN)

            assert.equal(mockOpenGarageApi.targetClosedState, false)
            assert.equal(openGarage.currentDoorState(), Characteristic.CurrentDoorState.CLOSED)
            assert.equal(openGarage.targetDoorState(),  Characteristic.TargetDoorState.OPEN)

            let [pollTimer, afterTimer] = MockSetTimeout.getTimers()
            assert.equal(pollTimer.duration,  pollFrequencyMs)  // regular poll
            assert.equal(afterTimer.duration, openDurationMs)   // post-open-duration poll

            // Simulate door having opened and time having elapsed
            mockOpenGarageApi.isClosed = false
            MockDate.currentTime += openDurationMs
            MockSetTimeout.invoke(afterTimer)

            await eventually(() => {
                assert.equal(mockOpenGarageApi.targetClosedState, false)
                assert.equal(openGarage.currentDoorState(), Characteristic.CurrentDoorState.OPEN)
                assert.equal(openGarage.targetDoorState(),  Characteristic.TargetDoorState.OPEN)
            })
        })

        it('reverts the target door state if the door does not change within openDurationMs', async () => {
            // Garage starts closed; request to open
            await targetDoorState.triggerSetAsync(Characteristic.TargetDoorState.OPEN)

            assert.equal(mockOpenGarageApi.targetClosedState, false)
            assert.equal(openGarage.currentDoorState(), Characteristic.CurrentDoorState.CLOSED)
            assert.equal(openGarage.targetDoorState(),  Characteristic.TargetDoorState.OPEN)

            let [pollTimer, afterTimer] = MockSetTimeout.getTimers()
            assert.equal(pollTimer.duration,  pollFrequencyMs)
            assert.equal(afterTimer.duration, openDurationMs)

            // Door did NOT open — fire the after-timer without advancing mock clock
            MockSetTimeout.invoke(afterTimer)

            // State should still show closed (door never opened)
            await eventually(() => {
                assert.equal(mockOpenGarageApi.targetClosedState, false)
                assert.equal(openGarage.currentDoorState(), Characteristic.CurrentDoorState.CLOSED)
                // target still shows OPEN because we haven't passed openDurationMs yet
                assert.equal(openGarage.targetDoorState(),  Characteristic.TargetDoorState.OPEN)
            })

            // Advance mock clock past open duration — target should revert to match actual state
            MockDate.currentTime += openDurationMs
            assert.equal(openGarage.targetDoorState(), Characteristic.TargetDoorState.CLOSED)
        })
    })
})
