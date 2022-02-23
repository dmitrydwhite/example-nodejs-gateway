/**
 * Welcome! We'll walk through the NodeJS implementation for running a Major Tom gateway to get you
 * started running your own gateway, and talking to your own hardware, in no time!
 */

// We use the JavaScript library to connect to Major Tom
const { newNodeGateway } = require('majortom-gateway');

// We get the connection parameters from connect/connection.json
const connectionProps = require('./connect/connection.json');
// `commandCallback` is a simple function that's required due to the structure of the Major Tom connection library.
// `runGateway` is our main implementation code. Check them both out in the file `./run/main.js`.
const { commandCallback, runGateway } = require('./run/main');
// A couple logger functions will show our title and remind us to add our required properties to `./connect/connection.json` if we forgot.
const { title, logFailure } = require('./utils/logger');
// Launch our fake satellite; it's just a small node app that will run in a separate process. Don't
// worry too much yet about how the fake satellite works--it's all just mocked out to behave something
// like a real satellite.
const satelliteConnection = require('child_process').fork('./faker_satellite/launch', { detached: false });

title();
// Show an error if our connection values aren't there:
if (!(connectionProps.gatewayToken && connectionProps.host)) {
  logFailure();
}

// Make our connection to Major Tom and connect it by calling the `.connect()` method:
const majorTomConnection = newNodeGateway({
  ...connectionProps,
  commandCallback,
  // verbose: true,
});
majorTomConnection.connect();

// Pass the Major Tom connection and the satellite connection to our implementation code.
// Check out the runGateway function in `./run/main.js` next!
runGateway(majorTomConnection, satelliteConnection);
