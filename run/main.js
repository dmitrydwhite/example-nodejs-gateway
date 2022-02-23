// We're going to use NodeJS's event paradigm to handle things happening in various orders
const EventEmitter = require('events');
// We'll use NodeJS's file system utility to handle downlinking files by temporarily storing them
// on the gateway as they're downlinked from the "satellite"
const fs = require('fs');
// The path utility will help normalize the file pathing
const path = require('path');
// We're also going to use NodeJS's stream paradigm to uplink and downlink files
const { Writable } = require('stream');

const broadcastCarrierSignal = require('../faker_antenna/broadcastCarrierSignal');
const prepGroundHardware = require('../faker_antenna/prepGroundHardware');
const orientAntenna = require('../faker_antenna/orientAntenna');
const syncCarrierSignalWithSat = require('../faker_antenna/syncCarrierSignalWithSat');
const validateChecksum = require('../faker_antenna/validateChecksum');

const { COMMAND_EVENT, UPDATE_EVENT } = require('../utils/constants');
const { log, title } = require('../utils/logger');

/**
 * This is the event emitter AND receiver that will handle all the asynchronous activity happening
 * between our gateway, our "satellite", and Major Tom.
 */
const gatewayControl = new EventEmitter();

/**
 * We'll define all of our command implementations here in this file for simplicity's sake; these
 * could very easily be made more modular and dynamic. For this demo, each command implementation
 * will be a Higher Order Function that takes the main gateway EventEmitter, the satellite
 * connection, the Major Tom connection, and returns a function that takes the command object.
 */

/**
 * Many of our commands don't require the gateway to do anything more than pass the command along to
 * the satellite and log what it's doing. We'll use a single function for those commands. We'll
 * transition the commands through the states that Major Tom expects, but if all goes smoothly then
 * most of these status updates may not register in the UI since they'll pass so quickly.
 * @param {EventEmitter} gatewayControl A reference to the main gateway event bus
 * @param {ChildProcess} satellite A reference to the gateway's satellite connection
 * @returns
 */
const passCommandToSat = (gatewayControl, satellite) => command => {
  const { id, system } = command;

  // Change the command state to "uplinking"
  gatewayControl.emit(UPDATE_EVENT, {
    type: 'command_update',
    command: {
      id,
      system,
      state: 'uplinking_to_system',
    },
  });
  // Send the command
  satellite.send(command);
  // Change the command state to "transmitted"
  gatewayControl.emit(UPDATE_EVENT, {
    type: 'command_update',
    command: {
      id: command.id,
      system,
      state: 'transmitted_to_system',
    },
  });
};

/**
 * Here we're starting to emulate how our gateway might behave when working with real hardware
 * instead of a single faked software process. We will likely want to wrap each task in a Promise so
 * we can handle all of the intermediate eventing within that asynchronous function, and report the
 * task's ultimate success or failure through the Promise's resolve and reject hooks. This is also
 * a rudimentary emulation of a gateway controlling multiple components of the system: in this
 * command we are not only sending data to the satellite, but also commanding the ground station
 * antenna.
 * @param {EventEmitter} gatewayControl A reference to the main gateway event bus
 * @param {ChildProcess} satellite A reference to the gateway's satellite connection
 * @returns
 */
const connect = (gatewayControl, satellite) => command => {
  const { id, system } = command;

  // Each of our satellite- and antenna-related tasks are Promises that wrap the event-based nature
  // of asynchronous JavaScript into an easily-consumed package. Those Promises may also take
  // "update functions" that can report on the intermediate progress of the task by emitting an
  // update event on the gatewayControl event emitter. Here we define our update functions:
  const updateHardwarePrep = (percent, status) => {
    gatewayControl.emit(UPDATE_EVENT, {
      type: 'command_update',
      command: {
        id,
        system,
        state: 'preparing_on_gateway',
        progress_1_current: percent,
        progress_1_max: 100,
        progress_1_label: status,
        status,
      },
    });
  };

  const updateOrient = (completed, remaining) => {
    gatewayControl.emit(UPDATE_EVENT, {
      type: 'command_update',
      command: {
        id,
        system,
        state: 'preparing_on_gateway',
        progress_2_current: completed,
        progress_2_max: completed + remaining,
        progress_2_label: 'Antenna degrees rotated',
      },
    });
  };

  const updateCarrier = (progress_1_current, status) => {
    gatewayControl.emit(UPDATE_EVENT, {
      type: 'command_update',
      command: {
        id,
        system,
        state: 'preparing_on_gateway',
        progress_1_current,
        progress_1_max: 100,
        progress_1_label: status,
        status,
      },
    });
  };

  const syncWithSat = (state, progress_1_current, progress_1_max) => {
    gatewayControl.emit(UPDATE_EVENT, {
      type: 'command_update',
      command: {
        id,
        system,
        state,
        progress_1_current,
        progress_1_max,
      },
    });
  };

  const sendChecksumUpdate = status => {
    gatewayControl.emit(UPDATE_EVENT, {
      type: 'command_update',
      command: {
        id,
        system,
        status,
        state: 'processing_on_gateway',
      },
    });
  };

  // For demonstration's sake, our first two tasks are simultaneous. To do this, we use Promise.all
  Promise.all([
    prepGroundHardware({ updateFn: updateHardwarePrep }),
    orientAntenna({ updateFn: updateOrient }),
  ]).then(async () => {
    // The next set of tasks will run sequentially; the `await` syntax will ensure that one task is
    // resolved before the next one starts. Since these `await`-ed methods are inside a Promise's
    // `.then` callback, we don't need to wrap them in a try/catch; rather any rejections will be
    // handled in the `.catch` callback.
    await broadcastCarrierSignal({ updateFn: updateCarrier });
    // Since this task will be communicating with the satellite, we'll also pass it a reference to
    // the satellite connection:
    await syncCarrierSignalWithSat({ updateFn: syncWithSat, satellite });
    const checksum = await validateChecksum({ updateFn: sendChecksumUpdate });

    gatewayControl.emit(UPDATE_EVENT, {
      type: 'command_update',
      command: {
        id,
        system,
        state: 'completed',
        payload: `Checksum: ${checksum}`,
      },
    });
  }).catch(err => {
    gatewayControl.emit(UPDATE_EVENT, {
      type: 'command_update',
      command: {
        id,
        system,
        state: 'failed',
        errors: [err.toString()],
      },
    });
  });
};

/**
 * The Major Tom gateway library allows us to provide a writable stream where the file we download
 * from Major Tom can be written as it's downloaded.
 * @param {EventEmitter} gatewayControl
 * @param {ChildProcess} satellite
 * @param {MajorTomGateway} majorTom
 * @returns
 */
const uplink_file = (gatewayControl, satellite, majorTom) => command => {
  const { id, system, fields = [] } = command;
  const gateway_download_path = (fields.find(f => f.name === 'gateway_download_path') || {}).value;
  let chunksSent = 0;
  // This stream is the "destination" for our download from Major Tom. Each piece of the downloaded
  // file we receive will be sent to the "satellite" over our connection.
  const fileTransmitStream = new Writable({
    write: (chunk, _, cb) => {
      chunksSent += 1;
      satellite.send({ id, chunk, chunksSent, type: 'uplink_file_chunk' });
      gatewayControl.emit(UPDATE_EVENT, {
        type: 'command_update',
        command: {
          id,
          system,
          state: 'uplinking_to_system',
          progress_1_current: chunksSent,
          progress_1_max: Math.max(10, chunksSent + 2),
          progress_1_label: 'File Chunks Sent',
        },
      });
      cb();
    },
  });

  if (!gateway_download_path) {
    gatewayControl.emit(UPDATE_EVENT, {
      type: 'command_update',
      command: {
        id,
        system,
        state: 'failed',
        errors: ['uplink_file failed because the value for gateway_download_path was not provided'],
      },
    });

    return;
  }

  // Before we start, update Major Tom UI that we're starting the uplink.
  gatewayControl.emit(UPDATE_EVENT, {
    type: 'command_update',
    command: {
      id,
      system,
      state: 'uplinking_to_system',
      progress_1_current: 0,
      progress_1_max: 10,
      progress_1_label: 'File Chunks Sent',
    },
  });
  // Use the library method to downlink the file from Major Tom and stream it to the "satellite".
  majorTom.downloadStagedFile(gateway_download_path, fileTransmitStream);

  // When the file uplink has finished, update Major Tom UI that we've finished sending the file.
  fileTransmitStream.on('finish', () => {
    satellite.send({ id, type: 'uplink_ended' });
    gatewayControl.emit(UPDATE_EVENT, {
      type: 'command_update',
      command: {
        id,
        system,
        state: 'transmitted_to_system',
      },
    });
  });
};

/**
 * The implementation for downlinking a file from the satellite and then uploading it to Major Tom.
 * @param {EventEmitter} gatewayControl Interaction with gateway events
 * @param {*} satellite The satellite connection
 * @param {*} majorTom The connection to the Major Tom gateway library
 * @returns
 */
const downlink_file = (gatewayControl, satellite, majorTom) => command => {
  const { id, system, fields = [] } = command;
  const filename = (fields.find(({ name }) => name === 'filename') || {}).value;
  const state = 'downlinking_from_system';
  const progress_1_label = 'File chunks downlinked';
  const tempFileLocation = path.join(__dirname, 'downlinked_files', filename);
  const tempFileDir = path.dirname(tempFileLocation);
  let progress_1_current = 0;
  let progress_1_max = 0;

  if (!fs.existsSync(tempFileDir)) {
    fs.mkdirSync(tempFileDir, { recursive: true });
  }

  const tempFileStream = fs.createWriteStream(tempFileLocation);

  const tempUpdateListener = ({ type, downlink_id, chunk }) => {
    if (type === 'file_contents_update' && downlink_id === id) {
      progress_1_current += 1;
      progress_1_max = Math.max(10, progress_1_current + 2);

      tempFileStream.write(Buffer.from(chunk.data));

      gatewayControl.emit(UPDATE_EVENT, {
        type: 'command_update',
        command: { id, system, state, progress_1_current, progress_1_max, progress_1_label },
      });
    }

    if (type === 'file_contents_finished' && downlink_id === id) {
      gatewayControl.off(UPDATE_EVENT, tempUpdateListener);

      if (chunk && chunk.data && chunk.data.length) {
        progress_1_current += 1;
        progress_1_max = progress_1_current;

        tempFileStream.write(Buffer.from(chunk.data));

        gatewayControl.emit(UPDATE_EVENT, {
          type: 'command_update',
          command: { id, system, state, progress_1_current, progress_1_max, progress_1_label },
        });
      }

      tempFileStream.end();

      gatewayControl.emit(UPDATE_EVENT, {
        type: 'command_update',
        command: {
          id,
          system,
          state: 'processing_on_gateway',
          status: 'Uploading file to Major Tom over REST',
        },
      });

      majorTom
        .uploadDownlinkedFile(filename, tempFileLocation, system, Date.now(), 'image/jpeg', id)
        .then(() => {
          majorTom.completeCommand(id, `Downlink of ${filename} for command ${id} complete`);
        })
        .catch(error => {
          const errors = [
            new Error(`Problem uploading the file ${filename} to Major Tom`).toString(),
            error.toString(),
          ];

          majorTom.failCommand(id, errors);
        })
        .finally(() => {
          fs.unlinkSync(tempFileLocation);
        });
    }
  };

  if (!filename) {
    gatewayControl.emit(UPDATE_EVENT, {
      type: 'command_update',
      command: {
        id,
        system,
        state: 'failed',
        errors: ['No value received for field filename in downlink_file command'],
      },
    });
  } else {
    gatewayControl.on(UPDATE_EVENT, tempUpdateListener);
    passCommandToSat(gatewayControl, satellite)({ ...command, filename });
  }
};

/**
 * Here is the main functioning of our small demo gateway.
 * @param {MajorTomGateway} mtCx The connection between our gateway and Major Tom
 * @param {ChildProcess} satCx In this case, the node process emulating our satellite, but could be any kind of event emitter
 */
const runGateway = (mtCx, satCx) => {
  // Here is where we will handle a COMMAND received from Major Tom UI
  gatewayControl.on(COMMAND_EVENT, command => {
    const { id, type } = command;

    // For every command we receive, we'll inform Major Tom that we are preparing it on the gateway.
    mtCx.transmitCommandUpdate(id, 'preparing_on_gateway', command);

    switch (type) {
      // All of these commands don't require much action on the part of our gateway
      case 'ping':
      case 'telemetry':
      case 'update_file_list':
      case 'safemode':
      case 'tune_radio':
      case 'adjust_refractor':
      case 'power_cycle_camera':
      case 'stow_camera':
      case 'obtain_image':
      case 'reset_refractor':
        // So we made a single function that just passes the command along
        passCommandToSat(gatewayControl, satCx, mtCx)(command);
        break;
      // But these commands require our gateway to do some work: check out their definitions for details
      case 'uplink_file':
        uplink_file(gatewayControl, satCx, mtCx)(command);
        break;
      case 'downlink_file':
        downlink_file(gatewayControl, satCx, mtCx)(command);
        break;
      case 'connect':
        connect(gatewayControl, satCx, mtCx)(command);
        break;
      default:
        mtCx.transmitEvents({
          type: 'commandError',
          level: 'error',
          message: `Gateway has no implementation for command type ${type}`,
        });
    }

    // We placed our own logger here to demonstrate how you could implement your own logging function.
    log('command')(command);
  });

  // Here is where we'll handle a general update event happening within our gateway or from our
  // satellite--essentially our gateway communicating with itself about what is going on.
  gatewayControl.on(UPDATE_EVENT, update => {
    const { type, command = {}, event, measurements } = update;
    const { id, state } = command;

    switch (type) {
      // Inside this switch, we'll call the various methods that the majortom-gateway library
      // gives us based on the type of update we're receiving from the "satellite":
      case 'command_update':
        mtCx.transmitCommandUpdate(id, state, command);
        break;
      case 'measurements':
        mtCx.transmitMetrics(measurements);
        break;
      case 'event':
        mtCx.transmitEvents(event);
        break;
      case 'command_definitions_update':
      case 'file_list':
      case 'file_metadata_update':
        mtCx.transmit(update);
        break;
      // These updates from our "satellite" are internal only: they're "intermediate" updates for
      // downlinking files and "establishing contact" with the satellite. They'll be handled in the
      // implementation of those commands.
      case 'file_contents_update':
      case 'file_contents_finished':
      case 'checksum_pong':
        break;
      default:
        mtCx.transmitEvents({
          type: 'updateError',
          level: 'warning',
          message: 'The gateway received an update that it did not understand',
          debug: update,
        });
        break;
    }
    log('event')(update);
  });

  // Here is where we will handle incoming messages from our "satellite", converting from a string
  // or Buffer to an object.
  satCx.on('message', received => {
    // We could receive a buffer or a string from our fake "satellite". This emulates how serial
    // data is typically received, though in this case we're receiving data from a child process.
    const receivedBuffer = Buffer.isBuffer(received);
    const receivedString = typeof received === 'string';
    try {
      // We're going to assume that we are getting messages in JSON format; if that weren't the
      // case, here is one place where we would run our received data through some other parsing
      // function
      const update = (receivedBuffer && JSON.parse(received.toString())) ||
        (receivedString && JSON.parse(received)) ||
        received;

      gatewayControl.emit(UPDATE_EVENT, update);
    } catch (err) {
      // We'll most likely fall into this catch block if the attempt at `JSON.parse`-ing fails. We'll
      // emit an event to tell Major Tom about it.
      gatewayControl.emit(UPDATE_EVENT, {
        type: 'event',
        event: {
          type: 'formatError',
          level: 'error',
          debug: {
            errors: [new Error('Received a serial packet string or buffer that was not recognizable').toString(), err.toString()],
            received: receivedBuffer ? received.toString() : received,
          },
          message: 'There was a problem receiving downlinked data',
        },
      });
    }
  });

  return gatewayControl;
};

/**
 * This simple function is required to construct the connection between our gateway and Major Tom.
 * It communicates with the `runGateway` function using the gatewayControl EventEmitter in shared scope.
 * @param {Object} command The command object received from the Major Tom UI
 */
const commandCallback = command => {
  gatewayControl.emit(COMMAND_EVENT, command);
};

module.exports = {
  runGateway,
  commandCallback,
};
