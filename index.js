var paypal = require("paypal-node-sdk");
const express = require("express");
const CryptoJS = require("crypto-js");
var SHA256 = require("crypto-js/sha256");
const fs = require("fs");
const child = require("child_process");

let Config = {
  Port: 7000, // Port the payout system should be available at
  Wallet: 1000, // Amount of money available for payouts
  RateLimit: 1, // Amount of payouts per hour from the same email
  TransactionFee: 1, // Fees every user paying out money has to pay
  TransactionCosts: 0.98, // PayPal Transaction costs
  MaxValue: 100, // Max value a user can payout
  MinValue: 1, // Min value a user can payout
  TransactionCount: 0, // Amount of total transactions
  SucceededTransaction: 0, // Amount of succeeded transactions
  PendingTransaction: 0, // Amount of pending transactions
  FailedTransaction: 0, // Amount of failed transactions
  EmailLogsCache: {}, // Logs of email's getting payouts (Needed for the rate limit)
  TransactionLogs: [] // List containing all pending transactions
};

if (fs.existsSync("./Data.json")) {
  let Success = true;
  const TempConfig = JSON.parse(
    fs.readFileSync("./Data.json", { encoding: "utf8", flag: "r" })
  );
  for (var key in Config) {
    if(TempConfig[key] == null){
      Success = false;
    }
  }
  if(Success){
    Config = JSON.parse(
      fs.readFileSync("./Data.json", { encoding: "utf8", flag: "r" })
    );
  } else {
    fs.writeFileSync("./Data.json", JSON.stringify(Config));
  }
} else {
  fs.writeFileSync("./Data.json", JSON.stringify(Config));
}

paypal.configure({
  mode: "",
  client_id:
    "",
  client_secret:
    "",
});

const app = express();

setInterval(function(){
  const RealtimeData = JSON.parse(
    fs.readFileSync("./Data.json", { encoding: "utf8", flag: "r" })
  );
  for (var i = 0; i < RealtimeData.TransactionLogs.length; i++) {
    if(RealtimeData.TransactionLogs[i].Timestamp < Math.floor((((Date.now() / 1000)/60)/60)/24)){
      RealtimeData.Wallet = Math.round(RealtimeData.Wallet + parseInt(RealtimeData.TransactionLogs[i].Amount))
      RealtimeData.FailedTransaction = RealtimeData.FailedTransaction + 1
      RealtimeData.PendingTransaction = RealtimeData.PendingTransaction - 1;
      RealtimeData.TransactionLogs.splice(i,1) == null
      fs.writeFileSync("./Data.json", JSON.stringify(RealtimeData));
    }
  }
},1000)

app.get("/ping", (req, res) => {
  res.send({Status: "Success", Details: "The payment system is available"})
})

app.get("/payout/verify", (req, res) => {
  const PayoutBatchId = req.query.PayoutId;
  const VerificationId = req.query.VerificationId;
  let Success = false;
  for (var i = 0; i < Config.TransactionLogs.length; i++) {
    if (
      Config.TransactionLogs[i].BatchId == PayoutBatchId &&
      Config.TransactionLogs[i].Status == "PENDING" &&
      SHA256(Config.TransactionLogs[i].VerificationIdRaw) == VerificationId
    ) {
      Success = true;
      res.send({
        Status: "Success",
        Details: "Transaction verified.",
        BatchId: PayoutBatchId
      });
      Config.SucceededTransaction = Config.SucceededTransaction + 1;
      Config.TransactionLogs.splice(i,1); // Work on later!!!!
      fs.writeFileSync("./Data.json", JSON.stringify(Config));
      return;
    }
  }
  if (Success == false)
    return res.send({
      Status: "Error",
      Details: "Transaction can not be verified.",
    });
});

app.get("/payout/get", (req, res) => {
  const PayoutBatchId = req.query.PayoutId;
  let Success = false;
  for (var i = 0; i < Config.TransactionLogs.length; i++) {
    if (
      Config.TransactionLogs[i].BatchId == PayoutBatchId &&
      Config.TransactionLogs[i].Status == "PENDING"
    ) {
      Success = true;
      const command =
      'curl -v -X POST "https://api-m.sandbox.paypal.com/v1/oauth2/token" \
      -u "" \
      -H "Content-Type: application/x-www-form-urlencoded" \
      -d "grant_type=client_credentials"';
    child.exec(command, async (err, data) => {
      if (err)
        return res.send({
          Status: "Error",
          Details: "Transaction can not be verified.",
        });

      const command = `curl -v -X GET https://api-m.sandbox.paypal.com/v1/payments/payouts/${PayoutBatchId} \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer ${JSON.parse(data).access_token}"`;
      child.exec(command, async (err, data) => {
        if (err)
          return res.send({
            Status: "Error",
            Details: "PayPal API Error.",
          });
          res.send({
            Status: "Success",
            Details: "Transaction found.",
            BatchId: PayoutBatchId,
            TransactionStatus: JSON.parse(data).batch_header.batch_status
          });
          Config.PendingTransaction = Config.PendingTransaction - 1;
          Config.SucceededTransaction = Config.SucceededTransaction + 1;
          Config.TransactionLogs.splice(i,1); // Work on later!!!!
          fs.writeFileSync("./Data.json", JSON.stringify(Config));
          return;
      });
    });
    }
  }
  if (Success == false) {
    res.send({ Status: "Error", Details: "Transaction not found." });
    return;
  }
});

app.get("/payout/create", (req, res) => {
  const UserId = req.query.UserId || SHA256(`${new Date().getTime()}`);
  const Email = req.query.Email;
  const Amount = (
    Math.round(
      (parseInt(req.query.Amount) - Config.TransactionFee) *
        Config.TransactionCosts *
        100
    ) / 100
  ).toFixed(2);
  const VerificationIdRaw = `${Amount}|${new Date().getTime()}|${UserId}`;
  const VerificationId = SHA256(VerificationIdRaw);

  if (Amount > Config.MaxValue || Amount < Config.MinValue) {
    res.send({ Status: "Error", Details: "Invalid Transaction Amount." });
    return;
  }

  if(Config.EmailLogsCache[Email]){
    if(Config.EmailLogsCache[Email] == Math.floor(((Date.now() / 1000)/60)/60)){
      res.send({ Status: "Error", Details: "Rate Limit." });
      return;
    } else {
      delete Config.EmailLogsCache[Email]
    }
  }

  var sender_batch_id = Math.random().toString(36).substring(9);

  var create_payout_json = {
    sender_batch_header: {
      sender_batch_id: sender_batch_id,
      email_subject: "GD-System",
    },
    items: [
      {
        recipient_type: "EMAIL",
        amount: {
          value: Amount,
          currency: "EUR",
        },
        receiver: Email,
        note: `GD-System | Verification ID: ${VerificationId}`,
        sender_item_id: "Payment",
      },
    ],
  };

  paypal.payout.create(create_payout_json, "false", function (error, payout) {
    if (error) {
      res.send({ Status: "Error", Details: "PayPal API Error." });
      return
    } else {
      Config.TransactionCount = Config.TransactionCount + 1;
      Config.Wallet = Math.round(Config.Wallet - Amount);
      Config.TransactionLogs.push({
        Timestamp: Math.floor((((Date.now() / 1000)/60)/60)/24),
        Status: payout.batch_header.batch_status,
        BatchId: payout.batch_header.payout_batch_id,
        Amount: Amount,
        Email: Email,
        VerificationIdRaw: VerificationIdRaw,
        Response: CryptoJS.enc.Base64.stringify(
          CryptoJS.enc.Utf8.parse(JSON.stringify(payout))
        ),
      });
      Config.PendingTransaction = Config.PendingTransaction + 1;
      Config.EmailLogsCache[Email] = Math.floor(((Date.now() / 1000)/60)/60)
      fs.writeFileSync("./Data.json", JSON.stringify(Config));
      res.send({
        Status: "Success",
        Details: "Transaction is pending.",
        BatchId: payout.batch_header.payout_batch_id,
        Amount: Amount,
      });
      return
    }
  });
});

app.listen(Config.Port, () =>
  console.log(`Payment System - http://localhost:${Config.Port}`)
);