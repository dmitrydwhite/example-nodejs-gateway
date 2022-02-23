const startTelemetry = ({ sendFn, dest, systemName }) => {
  const telemetry = {
    battery: {
      voltage: {
        value: 3.9,
        step: 0.01,
        max: 4.2,
        min: 3,
      },
      temperature: {
        value: 20,
        step: 0.1,
        max: 35,
        min: 5,
      },
    },
    camera: (() => {
      let power = 1;
      let stowed = 1;

      const powerCycleCamera = () => new Promise(resolve => {
        power = 0;
        setTimeout(() => {
          power = 1;
          dest.send(JSON.stringify({
            type: 'event',
            event: {
              type: 'cameraEvent',
              message: 'Camera power cycle detected',
              debug_json: JSON.stringify({
                cameraPower: power ? 'on' : 'off',
              }),
            },
          }));
          resolve();
        }, 5000);
      });

      const stowCamera = stow => {
        stowed = !!stow ? 1 : 0;
      };

      return {
        power: {
          value: power,
          setFn: powerCycleCamera,
        },
        stowed: {
          value: stowed,
          setFn: stowCamera,
        },
      };
    })(),
    refractor: (() => {
      let angle = 0;
      const setAngle = next => {
        if (Number.isFinite(next)) {
          angle = next;
        } else {
          throw new Error(`Cannot set refractor angle to ${typeof next}: ${next}`);
        }
      };

      return {
        angle: {
          value: angle,
          setFn: setAngle,
        },
      };
    })(),
    radio: (() => {
      let frequency = 0;
      let powerState = 0;

      const setFrequency = freq => {
        frequency = freq;
      };

      const setPower = on => {
        powerState = !!on ? 1 : 0;
      };

      return {
        frequency: {
          value: frequency,
          setFn: setFrequency,
        },
        power: {
          value: powerState,
          setFn: setPower,
        },
      };
    })(),
    panels: {
      temperature_x: {
        value: 25,
        step: 0.1,
        max: 35,
        min: 20,
      },
      temperature_y: {
        value: 25.5,
        step: 0.1,
        max: 35,
        min: 20,
      },
      temperature_z: {
        value: 24.5,
        step: 0.1,
        max: 35,
        min: 20,
      },
    },
  };

  const generate = () => {
    const measurements = [];

    Object.entries(telemetry).forEach(([subsystem, metricObj]) => {
      Object.entries(metricObj).forEach(([metric, { step, max, min, value, setFn }]) => {
        if (setFn) {
          // Do not change value
        } else if (value >= max) {
          telemetry[subsystem][metric].value = value - step;
        } else if (value <= min) {
          telemetry[subsystem][metric].value = value + step;
        } else {
          telemetry[subsystem][metric].value = value + (step * (Math.random() > 0.5 ? 1 : -1));
        }

        if (sendFn()) {
          measurements.push({
            system: systemName,
            subsystem,
            metric,
            value,
            timestamp: Date.now(),
          });
        }
      });
    });

    if (sendFn()) {
      dest.send(JSON.stringify({
        type: 'measurements',
        measurements,
      }));
    }
  };

  const safe = () => {
    clearInterval(telemInterval);
    setTimeout(() => {
      telemInterval = setInterval(generate, 1000);
    }, 1000 * 60 * 3);
  };

  const setSubsystem = (subsystem, metric, value) => {
    const toSet = telemetry[subsystem] && telemetry[subsystem][metric];
    const { setFn } = toSet;

    if (!setFn) {
      return dest.send(JSON.stringify({
        type: 'event',
        event: {
          type: 'Subystem Error',
          message: `Cannot manually change ${subsystem} ${metric}`,
        },
      }));
    }

    return setFn(value);
  };

  let telemInterval = setInterval(generate, 1000);

  return { safe, setSubsystem };
};

module.exports = startTelemetry;
