// // not needed if you use Netlify Dev
// if (process.env.NODE_ENV !== "production") {
//   require("dotenv-safe").config();
// }
// https://docs.honeycomb.io/getting-data-in/javascript/browser-js/#can-i-send-data-directly-to-honeycomb-from-the-browser
const axios = require("axios");
const honeycombWriteKey = process.env.HONEYCOMB_API_KEY;
const honeycombDatasetName = process.env.HONEYCOMB_DATASET_NAME;
const honeycombEndpoint = `https://api.honeycomb.io/1/events/${encodeURIComponent(
  honeycombDatasetName,
)}`;

exports.handler = async (event, context) => {
  // only allow POSTS
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 500,
      body: "unrecognized HTTP Method, must use POST to this endpoint",
    };
  }
  /* parse the string body into a useable JS object */
  const receivedData = JSON.parse(event.body);
  // console.log(receivedData.actionName);
  const UserIP = event.headers["x-nf-client-connection-ip"] || "127.0.0.1";
  // make sure not to send context.clientContext.identity.token, that is a security issue
  let dataToSend = {
    // client-sent fields
    ...receivedData,
    // server-sourced fields
    UserIP,
  };
  if (context.clientContext && context.clientContext.user) {
    // if we get here, it means Netlify Identity enabled
    // and Netlify Function request sent with JWT
    const netlifyUser = context.clientContext.user;
    dataToSend = {
      ...dataToSend,
      NetlifyUser_app_metadata:
        netlifyUser.app_metadata && netlifyUser.app_metadata.provider,
      NetlifyUser_email: netlifyUser.email,
      NetlifyUser_exp: netlifyUser.exp,
      NetlifyUser_sub: netlifyUser.sub,
      NetlifyUser_user_metadata: JSON.stringify(netlifyUser.user_metadata),
    };
  }
  try {
    const options = {
      method: "POST",
      headers: { "X-Honeycomb-Team": honeycombWriteKey },
      data: dataToSend,
      url: honeycombEndpoint,
    };
    await axios(options);
    return {
      statusCode: 200,
      body: "POST OK",
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: err,
    };
  }
};
