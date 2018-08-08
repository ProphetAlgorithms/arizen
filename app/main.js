// @flow
/*jshint esversion: 6 */
/*jslint node: true */
"use strict";

// Press F12 to open the DevTools. See https://github.com/sindresorhus/electron-debug.
// DO NOT COMMENT !!!
require("electron-debug")();
require("axios-debug-log");
const electron = require("electron");
const BrowserWindow = electron.BrowserWindow;
const {app, Menu, ipcMain, dialog} = require("electron");
const path = require("path");
const url = require("url");
const os = require("os");
const fs = require("fs-extra");
const passwordHash = require("password-hash");
const crypto = require("crypto");
const bitcoin = require("bitcoinjs-lib");
const bip32utils = require("bip32-utils");
const zerojs = require("zerojs");
const sql = require("sql.js");
const updater = require("electron-simple-updater");
const axios = require("axios");
const querystring = require("querystring");
const {List} = require("immutable");
const {translate} = require("./util.js");
const {DateTime} = require("luxon");
const {zerextra} = require("./zerextra.js");

let oldZAddrJSON;

const userWarningImportFileWithPKs = "New address(es) and a private key(s) will be imported. Your previous back-ups do not include the newly imported addresses or the corresponding private keys. Please use the backup feature of Zero Arizen to make new backup file and replace your existing Zero Arizen wallet backup. By pressing 'I understand' you declare that you understand this. For further information please refer to the help menu of Zero Arizen.";
const userWarningExportWalletUnencrypted = "You are going to export an UNENCRYPTED wallet ( ie your private keys) in plain text. That means that anyone with this file can control your ZERs. Store this file in a safe place. By pressing 'I understand' you declare that you understand this. For further information please refer to the help menu of Zero Arizen.";
const userWarningExportWalletEncrypted = "You are going to export an ENCRYPTED wallet and your private keys will be encrypted. That means that in order to access your private keys you need to know the corresponding username and password. In case you don't know them you cannot control the ZERs that are controled by these private keys. By pressing 'I understand' you declare that you understand this. For further information please refer to the help menu of Zero Arizen.";

// Uncomment if you want to run in production
// Show/Hide Development menu
process.env.NODE_ENV = "production";

function attachUpdaterHandlers() {
    function onUpdateDownloaded() {
        let version = updater.meta.version;
        dialog.showMessageBox({
            type: "info",
            title: "Update is here!",
            message: `Zero Arizen will close and the new ${version} version will be installed. When the update is complete, the Zero Arizen wallet will reopen.`
        }, function () {
            // application forces to update itself
            updater.quitAndInstall();
        });
    }

    updater.on("update-downloaded", onUpdateDownloaded);
}

updater.init({checkUpdateOnStart: true, autoDownload: true});
attachUpdaterHandlers();

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow;
let userInfo = {
    loggedIn: false,
    login: "",
    pass: "",
    walletDb: [],
    dbChanged: false
};

const defaultSettings = {
    lang: "en",
    fiatCurrency: "USD",
    notifications: 1,
    txHistory: 50,
    autoLogOffEnable: 0,
    autoLogOffTimeout: 60,
    explorerUrl: "https://zero.cryptonode.cloud/insight/",
    apiUrls: [
        "https://zeroapi.cryptonode.cloud/"
    ],
    secureNodeFQDN: "127.0.0.1",
    secureNodePort: 23800,
    domainFronting: false,
    domainFrontingUrl: "",
    domainFrontingHost: ""
};

const defaultInternalInfo = {pendingTxs: []};

let settings = defaultSettings;
let langDict;
let axiosApi;
let internalInfo = defaultInternalInfo;

setZeroDirs();
nodeUserPass();

const dbStructWallet = "CREATE TABLE wallet (id INTEGER PRIMARY KEY AUTOINCREMENT, pk TEXT, addr TEXT UNIQUE, lastbalance REAL, name TEXT);";
const dbStructSettings = "CREATE TABLE settings (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, value TEXT);";
const dbStructTransactions = "CREATE TABLE transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, txid TEXT, time INTEGER, address TEXT, vins TEXT, vouts TEXT, amount REAL, block INTEGER);";

function tr(key, defaultVal) {
    return (settings && settings.lang) ? translate(langDict, key, defaultVal) : defaultVal;
}

var nodeAlive = 0;

function setZeroStatus(status, pos) {
           if (mainWindow !== null) {
              if (pos === 0) {
                     mainWindow.webContents.executeJavaScript(`
                       document.getElementById("checkZeroStatus").innerHTML = ${JSON.stringify(status)};
                     `);
              } else if (pos === 1) {
                        mainWindow.webContents.executeJavaScript(`
                          document.getElementById("checkZeroQuit").innerHTML = ${JSON.stringify(status)};
                        `);
                }
           }
}

function setDefaultConf() {
  let DEFAULT_CONFIG_SETTINGS = [
                       "",
                       "",
                       "rpcport=23800",
                       "addnode=213.239.212.246:23801",
                       "addnode=64.237.50.236:23801",
                       "addnode=51.255.95.53:23801",
                       "addnode=79.137.70.151:23801",
                       "addnode=178.213.233.173:23801",
                       "addnode=86.31.59.86:23801",
                       "addnode=138.197.149.3:23801",
                       "addnode=145.239.71.6:23801",
                       "addnode=174.138.15.68:23801",
                       "addnode=zeroseed.cryptoforge.cc:23801",
                       "addnode=84.19.36.203:23801",
                       "addnode=zerocurrency.prophetalgorithms.com:23801",
                       "rpcallowip=127.0.0.1",
                       "server=1"
                       ];    
  let config = '';
  let nodeDataPath = "";
  let defaults = DEFAULT_CONFIG_SETTINGS;
  DEFAULT_CONFIG_SETTINGS[0] = "rpcuser=" + require('crypto').randomBytes(8).toString('base64'); 
  DEFAULT_CONFIG_SETTINGS[1] = "rpcpassword=" + require('crypto').randomBytes(32).toString('base64');
 
  for(var key in defaults) {
    config += defaults[key] + '\n';
  }

  if (os.platform() === "win32") {
        nodeDataPath = app.getPath("appData") + "\\zero\\";
    } else if (os.platform() === "darwin") {
          nodeDataPath = app.getPath("appData") + "/zero/"; 
      } else if (os.platform() === "linux") {
           nodeDataPath = app.getPath("home") + "/.zero_arizen/zero/.zero/"; 
      }
  if (!fs.existsSync(nodeDataPath + "zero.conf")) {
    fs.writeFileSync(nodeDataPath + "zero.conf", config);
  }
}

function startZeroNode() {   
    var pkey_expected_sha256sum = "8bc20a7f013b2b58970cddd2e7ea028975c88ae7ceb9259a5344a16bc2c0eef7";
    var vkey_expected_sha256sum = "4bd498dae0aacfd8e98dc306338d017d9c08dd0918ead18172bd0aec2fc5df82";
    var algo = 'sha256';
    var shaPKsum = crypto.createHash(algo); 
    var shaVKsum = crypto.createHash(algo);  
    const provingKey = "sprout-proving.key";
    const verifyingKey = "sprout-verifying.key";
    var nodePath = "";
    var nodeDataPath = "";
    var node = "";
    var cli = "";
    var provingPath = "";
    var nodeStart;
    var envHome = "";
    
    if (os.platform() === "win32") {
        node = "zcashd.exe";
        cli = "zcash-cli.exe";
        nodePath = app.getPath("appData") + "\\Zero_Arizen\\zero\\";
        provingPath = app.getPath("appData") + "\\ZcashParams\\";
        nodeDataPath = app.getPath("appData") + "\\zero\\";
        envHome = app.getPath("appData");
        nodeStart = require('child_process').exec;
    } else if (os.platform() === "darwin") {
         node = "zcashd";
         cli = "zcash-cli";
         nodePath = app.getPath("appData") + "/Zero_Arizen/zero/" ;
         provingPath = app.getPath("appData") + "/ZcashParams/";
         nodeDataPath = app.getPath("appData") + "/zero/";
         envHome = app.getPath("home");
         nodeStart = require('child_process').exec;
      } else if (os.platform() === "linux") {
           node = "zcashd";
           cli = "zcash-cli";
           nodePath = app.getPath("home") + "/.zero_arizen/zero/";
           provingPath = app.getPath("home") + "/.zero_arizen/zero/.zcash-params/";
           nodeDataPath = app.getPath("home") + "/.zero_arizen/zero/.zero/";
           envHome = nodePath;
           nodeStart = require('child_process').exec;
       }
 
   if (fs.existsSync(nodePath + node) && fs.existsSync(nodePath + cli) && fs.existsSync(provingPath + verifyingKey) && fs.existsSync(provingPath + provingKey) && fs.existsSync(nodeDataPath + 'zero.conf')) { 
           setZeroStatus("/ Checksum sprout-verifying.key ..", 0);         
           var vkeyStream = fs.ReadStream(provingPath + verifyingKey);
           vkeyStream.on('data', function(vksum) { shaVKsum.update(vksum); });
           vkeyStream.on('end', function() {
               var vksum = shaVKsum.digest('hex');
               if (vkey_expected_sha256sum === vksum) {
                        setZeroStatus("/ Checksum sprout-proving.key ..", 0);                       
                        var pkeyStream = fs.ReadStream(provingPath + provingKey);
                        pkeyStream.on('data', function(pksum) { shaPKsum.update(pksum); });
                        pkeyStream.on('end', function() {
                           var pksum = shaPKsum.digest('hex');               
                           if (pkey_expected_sha256sum === pksum) {           
                                 nodeAlive = 1;
                                 walletLoadMsg();
                                 nodeStart(nodePath.replace(" ", "\\ ") + node, {env: {'HOME': envHome}} ,function(err, data) {
                                                        if (err) {
                                                              nodeAlive = 0;
                                                              //console.log(err);
                                                              var errorMsg = err.message.toString().replace('\r','\n').replace('\n\n','\n').split("\n");                             
                                                              if (err.code === 137 || err.signal === 'SIGKILL') {
                                                                     setZeroStatus("/ Zero node killed, restart node ..", 0);
                                                                     startZeroNode();
                                                              } else if (err.message.endsWith("Zcash is probably already running.\n")) {
                                                                            nodeAlive = 1;
                                                                            setZeroStatus("/ Zero node is probably already running.", 0);
                                                                } else if (errorMsg.length === 13 || errorMsg.length === 14) {
                                                                               if (errorMsg[1] === "Before starting zcashd, you need to create a configuration file:") {
                                                                                      setZeroStatus("/ Missing zero.conf", 0); 
                                                                                      setZeroDirs();
                                                                                      nodeUserPass();
                                                                                      startZeroNode(); 
                                                                               }         
                                                                  } else if (errorMsg.length === 5 || errorMsg.length === 6 ) {
                                                                                     if (errorMsg[1] === "Error: Cannot find the Zcash network parameters in the following directory:") {
                                                                                            setZeroStatus("/ Missing network parameters", 0); 
                                                                                            setZeroDirs();
                                                                                            nodeUserPass();
                                                                                            checkZeroFilesAndStart(); 
                                                                                     }
                                                                                     if (err.signal === 'SIGABRT') {  
                                                                                            setZeroStatus("/ " + errorMsg[1], 0);                                                       
                                                                                     }
                                                                    } else if (errorMsg.length === 2) {
                                                                                        if (err.code === 3221225477) {
                                                                                               setZeroStatus("/ Missing network parameters", 0); 
                                                                                               setZeroDirs();
                                                                                               nodeUserPass();
                                                                                               checkZeroFilesAndStart(); 
                                                                                        }         
                                                                      } else if (errorMsg) {  
                                                                                  setZeroStatus("/ Node Error!", 0);
                                                                        }
                                                        } else {
                                                              nodeAlive = 0;
                                                              setZeroStatus("/ Zero node closed, restart node ..", 0);
                                                              startZeroNode();
                                                          }
                                                 });
                           } else { 
                                   console.log("Checksum of the proving key is not correct.");
                                   setZeroStatus("/ Checksum sprout-proving.key failed!", 0); 
                                   fs.unlinkSync(provingPath + provingKey);
                                   checkZeroFilesAndStart();                                 
                                   return "pkey_checksum_not_equal"; 
                             }
                       });               
               } else {
                       console.log("Checksum of the verifying key is not correct."); 
                       setZeroStatus("/ Checksum sprout-verifying.key failed!", 0); 
                       fs.unlinkSync(provingPath + verifyingKey);
                       checkZeroFilesAndStart();                   
                       return "vkey_checksum_not_equal";
                }
           });
   } else {
          setZeroDirs();
          nodeUserPass();
          checkZeroFilesAndStart();
     }  
}

function checkZeroFilesAndStart() {
   const https = require('https');
   const urlKeys = "https://z.cash/downloads/";
   const provingKey = "sprout-proving.key";
   const verifyingKey = "sprout-verifying.key";
   const urlExec = "https://drive.google.com/uc?export=download&id=";
   const nodeFileLinuxR = "10VAIKlxM-ha5zLUdVejZa9MghOR_RKBl";
   const cliFileLinuxR = "1OSfjysMmJru_T0QpD7s6uGGR0ZgPjPfN";
   const nodeFileMacR = "1LE3tVWTgqAlJSQKZtTo3j7N4nExf0hbY";
   const cliFileMacR = "1EaFhd6m2OeBunDquZo8UFw7Tj_P_4lfS";
   const nodeFileWindowsR = "1Ybm39kazQiFVqWAsZC9KTo7uo-cgiyRT";
   const cliFileWindowsR = "1fegubf-wNMkSp8nUuLWbW6boQySU89M8";
   const nodeFileLinuxL = "zcashd";
   const cliFileLinuxL = "zcash-cli";
   const nodeFileMacL = "zcashd";
   const cliFileMacL = "zcash-cli";
   const nodeFileWindowsL = "zcashd.exe";
   const cliFileWindowsL = "zcash-cli.exe";
   var nodeFileRemote = "";
   var nodeFileLocal = "";
   var cliFileRemote = "";
   var cliFileLocal = "";
   var nodePath = "";
   let provingPath = "";
    
   if (os.platform() === "win32") { 
        nodeFileLocal = nodeFileWindowsL;
        nodeFileRemote = nodeFileWindowsR;
        cliFileLocal = cliFileWindowsL;
        cliFileRemote = cliFileWindowsR;
        nodePath = app.getPath("appData") + "\\Zero_Arizen\\zero\\";
        provingPath = app.getPath("appData") + "\\ZcashParams\\";
    } else if (os.platform() === "darwin") {
           nodeFileLocal = nodeFileMacL;
           nodeFileRemote = nodeFileMacR;
           cliFileLocal = cliFileMacL;
           cliFileRemote = cliFileMacR;
           nodePath = app.getPath("appData") + "/Zero_Arizen/zero/";
           provingPath = app.getPath("appData") + "/ZcashParams/";
       } else if (os.platform() === "linux") {
             nodeFileLocal = nodeFileLinuxL;
             nodeFileRemote = nodeFileLinuxR;
             cliFileLocal = cliFileLinuxL;
             cliFileRemote = cliFileLinuxR;
             nodePath = app.getPath("home") + "/.zero_arizen/zero/";
             provingPath = app.getPath("home") + "/.zero_arizen/zero/.zcash-params/";
        }

  var filesMissing = [];
    
  if (!fs.existsSync(provingPath) || !fs.existsSync(nodePath)) {
           setZeroDirs();
  }  
   
  if (!fs.existsSync(provingPath + verifyingKey)) { filesMissing.push(verifyingKey); }
  if (!fs.existsSync(provingPath + provingKey)) { filesMissing.push(provingKey); }
  if (!fs.existsSync(nodePath + cliFileLocal)) { filesMissing.push(cliFileLocal); }
  if (!fs.existsSync(nodePath + nodeFileLocal)) { filesMissing.push(nodeFileLocal); }
  
  filesMissing.forEach(function(file,i) {      
   if (file === verifyingKey || file === provingKey ) { 
                    var url = urlKeys;
                    var dir = provingPath;
                    var remoteFile = file;
                    var localFile = file;
                    var filePerm = '0644';
   } else if (file === cliFileLocal || file === nodeFileLocal ) { 
             if (file === cliFileLocal) { 
                     var remoteFile = cliFileRemote;
                     var localFile = file ;
             } else if (file === nodeFileLocal) {
                      var remoteFile = nodeFileRemote;
                      var localFile = file ;
               }                  
                    var url = urlExec;
                    var dir = nodePath;
                    var filePerm = '0755';

     }
      https.get(url + remoteFile, (res) => {
          //console.log(res.statusCode);
          //console.log(res.headers);
          if (res.statusCode === 301 || res.statusCode === 302) {    
           https.get(res.headers.location, (res) => {
               if (res.statusCode === 200) {                       
                      var wstream = fs.createWriteStream(dir + localFile, { mode: parseInt(filePerm, 8) });     
                      res.pipe(wstream);
               }
              //console.log(res.statusCode);
              //console.log(res.headers);
            res.on('data', (d) => {      
            });
            res.on('end', () => {                     
                      if (filesMissing.indexOf(file) > -1) {
                          filesMissing.splice(filesMissing.indexOf(file), 1);
                       }
                 }); 
            }).on('error', (e) => { 
                 console.error(e);
                 //if (e.code === 'ECONNRESET') {}
              }); 
         } else if (res.statusCode === 200) {
                     var wstream = fs.createWriteStream(dir + localFile, { mode: parseInt(filePerm, 8) });     
                     res.pipe(wstream);
                 //console.log(res.statusCode);
                 //console.log(res.headers);
                 res.on('end', function() {                   
                      if (filesMissing.indexOf(file) > -1) {
                          filesMissing.splice(filesMissing.indexOf(file), 1);                    
                       }               
                 });
                }
       res.on('data', (d) => {      
       });
       }).on('error', (e) => { 
            console.error(e);
         });  
 });

     var timeoutId = setTimeout(function checkDownload() {
                          if (filesMissing.length === 0) {
                               startZeroNode();
                               clearTimeout(timeoutId);    
                          } else {
                                let s = function(){ if (filesMissing.length > 1) { return "s"; } else { return ""; }};
                                setZeroStatus("/ Downloading " +  filesMissing.length + " file" + s(), 0);               
                                setTimeout(checkDownload, 3000);
                            }
                     }, 0);
}

function nodeUserPass(userOrPasswd) {
          let nodeDataPath = "";

          if (os.platform() === "win32") {       
              nodeDataPath = app.getPath("appData") + "\\zero\\";
          } else if (os.platform() === "darwin") {      
               nodeDataPath = app.getPath("appData") + "/zero/";
            } else if (os.platform() === "linux") {             
                 nodeDataPath = app.getPath("home") + "/.zero_arizen/zero/.zero/";
           } 
        if (fs.existsSync(nodeDataPath + 'zero.conf')) {
          var login = [];
          var zeroConf = fs.readFileSync(nodeDataPath + 'zero.conf').toString().split("\n");
          zeroConf.forEach(function(line) {
              if (line.startsWith("rpcuser=")) {
                       login[0] = line.substr(8);         
              } else if (line.startsWith("rpcpassword=")) {
                           login[1] = line.substr(12);
                }     
          });
           if (login.length === 2) {
               settings.secureNodeUsername = login[0];
               settings.secureNodePassword = login[1];
               if (mainWindow !== null && typeof mainWindow !== 'undefined') {
                        mainWindow.webContents.send("settings", JSON.stringify(settings));
               }
               if (userOrPasswd === "username") {
                                  return login[0];
               } else if (userOrPasswd === "password") {
                               return login[1];
                 }
           
          } else { 
               console.log("User or Password missing.");
               return 0;
            }
        } else {
             return 0;
          }        
}

function walletLoadMsg() {
        let nodePath = "";
        let nodeDataPath = "";
        let cli = "";
        let envHome = "";
        var nodeCheck;

        if (os.platform() === "win32") {
            cli = "zcash-cli.exe";
            nodePath = app.getPath("appData") + "\\Zero_Arizen\\zero\\";
            nodeDataPath = app.getPath("appData") + "\\zero\\";
            envHome = app.getPath("appData");
            nodeCheck = require('child_process').exec;
        } else if (os.platform() === "darwin") {      
             cli = "zcash-cli";
             nodePath = app.getPath("appData") + "/Zero_Arizen/zero/";
             nodeDataPath = app.getPath("appData") + "/zero/";
             envHome = app.getPath("home");
             nodeCheck = require('child_process').exec;
          } else if (os.platform() === "linux") {             
               cli = "zcash-cli";
               nodePath = app.getPath("home") + "/.zero_arizen/zero/";
               nodeDataPath = app.getPath("home") + "/.zero_arizen/zero/.zero/";
               envHome = nodePath;
               nodeCheck = require('child_process').exec;
           } 
           
        if (fs.existsSync(nodeDataPath + 'zero.conf')) {        
               let checkWallet = setInterval(function() {
                   nodeCheck(nodePath.replace(" ", "\\ ") + cli + ' -rpcuser=' + settings.secureNodeUsername + ' -rpcpassword=' + settings.secureNodePassword + ' help',{env: {'HOME': envHome}}, function(err, data) {
                                                    if (err) {
                                                         //console.log(err);
                                                         var errorMsg = err.message.toString().replace('\r','\n').replace('\n\n','\n').split("\n");
                                                         if (errorMsg.length === 5) {
                                                                 if (errorMsg.includes("error code: -28")) {  
                                                                           setZeroStatus("/ " + errorMsg[3], 0);    
                                                                 }
                                                                 if (err.signal === 'SIGABRT') {  
                                                                           setZeroStatus("/ " + errorMsg[1], 0);
                                                                           clearInterval(checkWallet);
                                                                 } 
                                                         } else if (errorMsg.length === 3) {
                                                              if (errorMsg[1] === "error: incorrect rpcuser or rpcpassword (authorization failed)") {
                                                                  setZeroStatus("/ Incorrect rpcuser or rpcpassword", 0);
                                                                  clearInterval(checkWallet); 
                                                              }
                                                           } else if (errorMsg.length === 4) {
                                                                 if (errorMsg[1] === "error: couldn't connect to server: unknown (code -1)" || errorMsg[1] === "error: couldn't connect to server: EOF reached (code 1)") {
                                                                       setZeroStatus("/ error: couldn't connect to node", 0);
                                                                       clearInterval(checkWallet);                                                             
                                                                 }                 
                                                            } else if (errorMsg) {
                                                                         clearInterval(checkWallet);
                                                              }   
                                                    } else { 
                                                            setZeroStatus("", 0);
                                                            clearInterval(checkWallet);                                                        
                                                      }
                                                 });          
         }, 1000);       
        } else {
              setZeroStatus("/ Missing zero.conf", 0);
          }
}

function stopZeroNode() {
        let nodePath = "";
        let nodeDataPath = "";
        let cli = "";
        let envHome = "";
        var nodeStop;

        if (os.platform() === "win32") {
            cli = "zcash-cli.exe";
            nodePath = app.getPath("appData") + "\\Zero_Arizen\\zero\\";
            nodeDataPath = app.getPath("appData") + "\\zero\\";
            envHome = app.getPath("appData");
            nodeStop = require('child_process').exec;
        } else if (os.platform() === "darwin") {      
             cli = "zcash-cli";
             nodePath = app.getPath("appData") + "/Zero_Arizen/zero/";
             nodeDataPath = app.getPath("appData") + "/zero/";
             envHome = app.getPath("home");
             nodeStop = require('child_process').exec;
          } else if (os.platform() === "linux") {             
               cli = "zcash-cli";
               nodePath = app.getPath("home") + "/.zero_arizen/zero/";
               nodeDataPath = app.getPath("home") + "/.zero_arizen/zero/.zero/";
               envHome = nodePath;
               nodeStop = require('child_process').exec;
           } 
          
         setZeroStatus("/ Quitting ..", 1);
    
                    let timeoutId = setTimeout(function stopNode () {
                       nodeStop(nodePath.replace(" ", "\\ ") + cli + ' -rpcuser=' + settings.secureNodeUsername + ' -rpcpassword=' + settings.secureNodePassword + ' stop',{env: {'HOME': envHome}}, function(err, data) {
                                                         
                                                         if (err === null) {
                                                            console.log('Zero quitting.');
                                                            app.quit();
                                                        } else {
                                                             //console.log(err);
                                                             var errorMsg = err.message.toString().replace('\r','\n').replace('\n\n','\n').split("\n");
                                                             if (errorMsg.length === 4) {
                                                               if (errorMsg[1] === "error: couldn't connect to server: unknown (code -1)" || errorMsg[1] === "error: couldn't connect to server: EOF reached (code 1)") {
                                                                     app.quit();
                                                               }
                                                             } else if (errorMsg.length === 5) {
                                                                    if (errorMsg[1].endsWith("-28")) {  
                                                                           setTimeout(stopNode, 1000);
                                                                    }
                                                                    if (err.signal === 'SIGABRT') {  
                                                                           setZeroStatus("/ " + errorMsg[1], 0);
                                                                           clearInterval(stopNode);
                                                                           app.quit();                                                                 
                                                                    }
                                                               } else if (errorMsg.length === 3) {
                                                                       if (errorMsg[1].endsWith("not found")) {  
                                                                               app.quit();
                                                                       }
                                                                       if (errorMsg[1] === "Error reading configuration file: Missing zero.conf") {
                                                                               setZeroStatus("/ Missing zero.conf", 0); 
                                                                               setZeroDirs();
                                                                               setTimeout(stopNode, 1000);
                                                                      }         
                                                                 } 
                                                         }    
                                                 });                          
                        }, 0);      
} 

function setZeroDirs() {
    let paths = [];
    let checkDir = function (pathList) {
            pathList.forEach(function(path) {
                if (!fs.existsSync(path)) {
                        fs.mkdirSync(path);
                }

           });
       };
    if (os.platform() === "win32") { 
        paths.push(app.getPath("appData") + "\\Zero_Arizen\\");       
        paths.push(app.getPath("appData") + "\\Zero_Arizen\\zero\\");
        paths.push(app.getPath("appData") + "\\ZcashParams\\");
        paths.push(app.getPath("appData") + "\\zero\\");
        checkDir(paths);
        if (!fs.existsSync(app.getPath("appData") + "\\zero\\" + "zero.conf")) { setDefaultConf(); }
    } else if (os.platform() === "darwin") { 
          paths.push(app.getPath("appData") + "/Zero_Arizen/");       
          paths.push(app.getPath("appData") + "/Zero_Arizen/zero/");
          paths.push(app.getPath("appData") + "/ZcashParams/");
          paths.push(app.getPath("appData") + "/zero/");
          checkDir(paths);
          if (!fs.existsSync(app.getPath("appData") + "/zero/" + "zero.conf")) { setDefaultConf(); }
      }
      else if (os.platform() === "linux") {      
            paths.push(app.getPath("home") + "/.zero_arizen/");       
            paths.push(app.getPath("home") + "/.zero_arizen/zero/");
            paths.push(app.getPath("home") + "/.zero_arizen/zero/.zcash-params/");
            paths.push(app.getPath("home") + "/.zero_arizen/zero/.zero/");
            checkDir(paths); 
            if (!fs.existsSync(app.getPath("home") + "/.zero_arizen/zero/" + ".zero/zero.conf")) { setDefaultConf(); }  
      } else {
        console.log("Unidentified OS.");
        app.exit(0);
    }
}

function getRootConfigPath() {
    let rootPath = "";
    if (os.platform() === "win32" || os.platform() === "darwin") {
        rootPath = app.getPath("appData") + "/Zero_Arizen/";
    } else if (os.platform() === "linux") {
        rootPath = app.getPath("home") + "/.zero_arizen/";
        if (!fs.existsSync(rootPath)) {
            fs.mkdirSync(rootPath);
        }
    } else {
        console.log("Unidentified OS.");
        app.exit(0);
    }
    return rootPath;
}

function getWalletPath() {
    return getRootConfigPath() + "wallets/";
}

function storeFile(filename, data) {
    const filenameTmp = filename + ".bak";
    fs.writeFileSync(filenameTmp, data, function (err) {
        if (err) {
            return console.log(err);
        }
    });
    fs.renameSync(filenameTmp, filename);
}

function encryptWallet(login, password, inputBytes) {
    let iv = Buffer.concat([Buffer.from(login, "utf8"), crypto.randomBytes(64)]);
    let salt = crypto.randomBytes(64);
    let key = crypto.pbkdf2Sync(password, salt, 2145, 32, "sha512");
    let cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    let encrypted = Buffer.concat([cipher.update(inputBytes), cipher.final()]);

    return Buffer.concat([iv, salt, cipher.getAuthTag(), encrypted]);
}

function decryptWallet(login, password, path) {
    let i = Buffer.byteLength(login);
    let inputBytes = fs.readFileSync(path);
    let recoveredLogin = inputBytes.slice(0, i).toString("utf8");
    let outputBytes = [];

    if (login === recoveredLogin) {
        let iv = inputBytes.slice(0, i + 64);
        i += 64;
        let salt = inputBytes.slice(i, i + 64);
        i += 64;
        let tag = inputBytes.slice(i, i + 16);
        i += 16;
        let encrypted = inputBytes.slice(i);
        let key = crypto.pbkdf2Sync(password, salt, 2145, 32, "sha512");
        let decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);

        decipher.setAuthTag(tag);
        outputBytes = decipher.update(encrypted, "binary", "binary");
        try {
            outputBytes += decipher.final("binary");
        } catch (err) {
            /*
             * Let's hope node.js crypto won't change error messages.
             * https://github.com/nodejs/node/blob/ee76f3153b51c60c74e7e4b0882a99f3a3745294/src/node_crypto.cc#L3705
             * https://github.com/nodejs/node/blob/ee76f3153b51c60c74e7e4b0882a99f3a3745294/src/node_crypto.cc#L312
             */
            if (err.message.match(/Unsupported state or unable to authenticate data/)) {
                /*
                 * User should be notified that wallet couldn't be decrypted because of an invalid password.
                 */
                outputBytes = -1;
            } else if (err.message.match(/Unsupported state/)) {
                /*
                 * User should be notified that wallet couldn't be decrypted because the wallet file is corrupted.
                 */
                outputBytes = -2;
            } else {
                // FIXME: handle other errors
                throw err;
            }
        }
    }
    return outputBytes;
}

function importWallet(filename, encrypt) {
    // check if file format is correct. Allow only awd and uawd file formats.
    if (filename.indexOf("awd") === -1 && filename.indexOf("uawd") === -1) {
        // TODO: add it to translation
        dialog.showErrorBox(tr("login.walletImportFailedBadFileFormat", "Import failed"), tr("login.dataImportFailed", "Wallet data format is incorrect - only awd and uawd file formats are supported."));
    }

    let data;
    if (encrypt === true) {
        data = decryptWallet(userInfo.login, userInfo.pass, filename);
    } else {
        data = fs.readFileSync(filename);
    }

    if (data === -1) {
        dialog.showErrorBox(tr("login.walletImportFailed", "Import failed"), tr("login.dataImportFailed1", "Data import failed, possible reason is wrong credentials or file is corrupted."));
    } else if (data === -2) {
        dialog.showErrorBox(tr("login.walletImportFailed", "Import failed"), tr("login.dataImportFailed2", "Data import failed, possible reason is wrong credentials."));
    } else if (data.length > 1) {
        if (encrypt) {
            fs.copy(filename, getWalletPath() + userInfo.login + ".awd");
        }
        userInfo.dbChanged = true;
        userInfo.walletDb = new sql.Database(data);
        mainWindow.webContents.send("call-get-wallets");
        mainWindow.webContents.send("show-notification-response", "Import", tr("login.walletImported", "Wallet imported succesfully"), 3);
    }
}

function exportWallet(filename, encrypt) {
    let data = userInfo.walletDb.export();
    if (encrypt === true) {
        data = encryptWallet(userInfo.login, userInfo.pass, data);
    }
    storeFile(filename, data);
}

function pruneBackups(backupDir, walletName) {
    // shamelessly inspired by borg backup

    const pruneConfig = {
        last: 5,
        hourly: 10,
        daily: 10,
    };

    const PRUNING_PATTERNS = [
        ["secondly", "yyyy-LL-dd HH:mm:ss"],
        ["minutely", "yyyy-LL-dd HH:mm"],
        ["hourly",   "yyyy-LL-dd HH"],
        ["daily",    "yyyy-LL-dd"],
        ["weekly",   "kkkk-WW"],
        ["monthly",  "yyyy-LL"],
        ["yearly",   "yyyy"]];

    const PRUNING_PATTERNS_DICT = {};
    PRUNING_PATTERNS.forEach(x => PRUNING_PATTERNS_DICT[x[0]] = x[1]);

    function listBackupFiles() {
        const filterRE = new RegExp("^" + walletName + "-\\d{14}\\.awd$");
        let files = fs.readdirSync(backupDir);
        files = files.filter(filename => filterRE.test(filename));
        files.sort();
        files.reverse();
        return files;
    }

    function pruneLast(files, n) {
        return files.slice(0, n || 0);
    }

    function pruneSplit(files, rule, n) {
        let last = null;
        let keep = [];
        if (!n) {
            return keep;
        }
        for (let f of files) {
            let stats = fs.statSync(backupDir + "/" + f);
            let period = DateTime
                .fromJSDate(stats.mtime)
                .toFormat(PRUNING_PATTERNS_DICT[rule]);
            if (period !== last) {
                last = period;
                keep.push(f);
                if (keep.length === n) {
                    break;
                }
            }
        }
        return keep;
    }

    let files = listBackupFiles();
    let toDelete = new Set(files);

    pruneLast(files, pruneConfig.last)
        .forEach(f => toDelete.delete(f));
    PRUNING_PATTERNS.forEach(rule =>
        pruneSplit(files, rule[0], pruneConfig[rule[0]])
            .forEach(f => toDelete.delete(f)));

    for (let f of toDelete) {
        fs.unlinkSync(backupDir + "/" + f);
    }
}

function saveWallet() {
    const walletPath = getWalletPath() + userInfo.login + ".awd";

    if (fs.existsSync(walletPath)) {
        const backupDir = getWalletPath() + "backups";
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir);
        }
        const timestamp = DateTime.local().toFormat("yyyyLLddHHmmss");
        const backupPath = backupDir + "/" + userInfo.login + "-" + timestamp + ".awd";
        //fs.copyFileSync(walletPath, backupPath);
        // piece of shit node.js ecosystem, why the fuck do we have to deal with fs-extra crap here?
        fs.copySync(walletPath, backupPath);
        pruneBackups(backupDir, userInfo.login);
    }

    exportWallet(walletPath, true);
    userInfo.dbChanged = false;
}

function generateNewAddress(count, password) {
    let i;
    let seedHex = passwordHash.generate(password, {
        "algorithm": "sha512",
        "saltLength": 32
    }).split("$")[3];

    // chains
    let hdNode = bitcoin.HDNode.fromSeedHex(seedHex);
    let chain = new bip32utils.Chain(hdNode);

    for (i = 0; i < count; i += 1) {
        chain.next();
    }

    // Get private keys from them - return privateKeys
    return chain.getAll().map(function (x) {
        return chain.derive(x).keyPair.toWIF();
    });
}

/* wallet generation from kendricktan */
function generateNewWallet(login, password) {
    let i;
    let pk;
    let pubKey;
    let db = new sql.Database();
    let privateKeys = generateNewAddress(1, password);

    // Run a query without reading the results
    db.run(dbStructWallet);
    db.run(dbStructTransactions);
    db.run(dbStructSettings);
    for (i = 0; i < 1; i += 1) {
        pk = zerojs.address.WIFToPrivKey(privateKeys[i]);
        pubKey = zerojs.address.privKeyToPubKey(pk, true);
        db.run("INSERT INTO wallet VALUES (?,?,?,?,?)", [null, pk, zerojs.address.pubKeyToAddr(pubKey), 0, ""]);
    }

    let data = db.export();
    let walletEncrypted = encryptWallet(login, password, data);
    storeFile(getWalletPath() + login + ".awd", walletEncrypted);
}

function getNewAddress(name) {
    let pk;
    let addr;
    let privateKeys = generateNewAddress(1, userInfo.pass);

    pk = zerojs.address.WIFToPrivKey(privateKeys[0]);
    addr = zerojs.address.pubKeyToAddr(zerojs.address.privKeyToPubKey(pk, true));
    userInfo.walletDb.run("INSERT INTO wallet VALUES (?,?,?,?,?)", [null, pk, addr, 0, name]);
    saveWallet();

    return {addr: addr, name: name, lastbalance: 0, pk: pk, wif: privateKeys[0]};
}

function sqlSelect(asObjects, sql, ...args) {
    const stmt = userInfo.walletDb.prepare(sql);
    stmt.bind(args);
    const results = [];
    while (stmt.step()) {
        let row = asObjects ? stmt.getAsObject() : stmt.get();
        results.push(row);
    }
    return results;
}

function sqlSelectColumns(sql, ...args) {
    return sqlSelect(false, sql, ...args);
}

function sqlSelectObjects(sql, ...args) {
    return sqlSelect(true, sql, ...args);
}

function sqlRun(sql, ...args) {
    const result = userInfo.walletDb.run(sql, args);
    userInfo.dbChanged = true;
    return result;
}

function tableExists(table) {
    return sqlSelectColumns(`select count(*) from sqlite_master where type = 'table' and name = '${table}'`)[0][0] === 1;
}

function loadSettings() {
    /* Remove settings row from settings table. Old versions chceks row count in
     * the table and inserts missing settings if the count isn't 6. By inserting
     * another setting we fucked up its fucked up upgrade logic. This only
     * happens in old versions after new version (f422bfff) run. */
    if (tableExists("settings")) {
        sqlRun("delete from settings where name = 'settings'");
    }
    /* In future we'll ditch SQLite and use encrypted JSONs for storage. For now
     * store settings in temporary table "new_settings". */
    if (!tableExists("new_settings")) {
        sqlRun("create table new_settings (name text unique, value text)");
    }

    const b64settings = sqlSelectColumns("select value from new_settings where name = 'settings'");
    if (b64settings.length === 0) {
        return defaultSettings;
    }

    /* Later we'll want to merge user settings with default settings. */
    return JSON.parse(Buffer.from(b64settings[0][0], "base64").toString("ascii"));
}

function loadInternalInfo() {
    const b64internalInfo = sqlSelectColumns("select value from new_settings where name = 'internalInfo'");
    if (b64internalInfo.length === 0) {
        return defaultInternalInfo;
    }
    return JSON.parse(Buffer.from(b64internalInfo[0][0], "base64").toString("ascii"));
}

function saveSettings(settings) {
    const b64settings = Buffer.from(JSON.stringify(settings)).toString("base64");
    sqlRun("insert or replace into new_settings (name, value) values ('settings', ?)", b64settings);
    saveWallet();
}

function saveInternalInfo(internalInfo) {
    const b64internalInfo = Buffer.from(JSON.stringify(internalInfo)).toString("base64");
    sqlRun("insert or replace into new_settings (name, value) values ('internalInfo', ?)", b64internalInfo);
    saveWallet();
}

function setSettings(newSettings) {
    newSettings.secureNodeFQDN = settings.secureNodeFQDN;
    newSettings.secureNodeUsername = settings.secureNodeUsername;
    newSettings.secureNodePassword = settings.secureNodePassword;
    settings = newSettings;

    if (settings.domainFronting) {
        axiosApi = axios.create({
            baseURL: settings.domainFrontingUrl,
            headers: {
                "Host": settings.domainFrontingHost
            },
            timeout: 30000,
        });
    }
    else {
        axiosApi = axios.create({
            baseURL: "https://zeroapi.cryptonode.cloud/",
            timeout: 30000,
        });
    }
}

function setInternalInfo(newInternalInfo) {
    internalInfo = newInternalInfo;
}

function upgradeDb() {
    // expects DB to be prefilled with addresses
    let addr = sqlSelectObjects("select * from wallet limit 1")[0];
    if (!("name" in addr)) {
        sqlRun("ALTER TABLE wallet ADD COLUMN name TEXT DEFAULT ''");
    }
}

function exportWalletArizen(ext, encrypt) {
    let showMessage = "";
    if (encrypt) {
        showMessage = tr("warmingMessages.userWarningExportWalletEncrypted", userWarningExportWalletEncrypted);
    } else {
        showMessage = tr("warmingMessages.userWarningExportWalletUnencrypted", userWarningExportWalletUnencrypted);
    }
    dialog.showMessageBox({
        type: "warning",
        title: "Important Information",
        message: showMessage,
        buttons: [tr("warmingMessages.userWarningIUnderstand", "I understand"), tr("warmingMessages.cancel", "Cancel")],
        cancelId: -1
    }, function (response) {
        if (response === 0) {
            dialog.showSaveDialog({
                title: "Save wallet." + ext,
                filters: [{name: "Wallet", extensions: [ext]}],
                defaultPath: userInfo.login
            }, function (filename) {
                if (typeof filename !== "undefined" && filename !== "") {
                    if (!fs.exists(filename)) {
                        dialog.showMessageBox({
                            type: "warning",
                            message: "Do you want to replace file?",
                            buttons: ["Yes", "No"],
                            title: "Replace wallet?"
                        }, function (response) {
                            if (response === 0) {
                                exportWallet(filename, encrypt);
                            }
                        });
                    } else {
                        exportWallet(filename, encrypt);
                    }
                }
            });
        }
    });
}

function importWalletArizen(ext, encrypted) {
    if (userInfo.loggedIn) {
        dialog.showOpenDialog({
            title: "Import wallet." + ext,
            filters: [{name: "Wallet", extensions: [ext]}]
        }, function (filePaths) {
            if (filePaths) {
                dialog.showMessageBox({
                    type: "warning",
                    message: "This will replace your actual wallet. Are you sure?",
                    buttons: ["Yes", "No"],
                    title: "Replace wallet?"
                }, function (response) {
                    if (response === 0) {
                        importWallet(filePaths[0], encrypted);
                    }
                });
            }
        });
    }
}

function exportPKs() {
    // function exportToFile(filename, override = False) {
    function exportToFile(filename) {
        fs.open(filename, "w", 0o600, (err, fd) => {
            if (err) {
                console.error(`Couldn't open "${filename}" for writing: `, err);
            } else {
                const keys = sqlSelectObjects("select pk, addr from wallet where length(addr)=35");
                for (let k of keys) {
                    if (zerextra.isPK(k.pk)) {
                        const wif = zerojs.address.privKeyToWIF(k.pk, true);
                        fs.write(fd, wif + " " + k.addr + "\n");
                    }
                }
                const zkeys = sqlSelectObjects("select pk, addr from wallet where length(addr)=95");
                for (let k of zkeys) {
                    if (zerextra.isPK(k.pk)) {
                        const spendingKey = zerojs.zaddress.zSecretKeyToSpendingKey(k.pk);
                        fs.write(fd, spendingKey + " " + k.addr + "\n");
                    }
                }
            }
        });
    }

    dialog.showMessageBox({
        type: "warning",
        title: "Important Information",
        message: tr("warmingMessages.userWarningExportWalletUnencrypted", userWarningExportWalletUnencrypted),
        buttons: [tr("warmingMessages.userWarningIUnderstand", "I understand"), tr("warmingMessages.cancel", "Cancel")],
        cancelId: -1
    }, function (response) {
        if (response === 0) {
            dialog.showSaveDialog({
                type: "warning",
                title: "Choose file for private keys",
                defaultPath: "zero-arizen-private-keys-" + userInfo.login + ".txt"
            }, filename => {
                if (filename) {
                    exportToFile(filename);
                }
            });
        }
    });
}

// input is PK not wif, not spending key
function importOnePK(pk, name = "", isT = true) {
    try {
        let addr;
        if (isT) {
            if (pk.length !== 64) {
                pk = zerojs.address.WIFToPrivKey(pk);
            }
            const pub = zerojs.address.privKeyToPubKey(pk, true);
            addr = zerojs.address.pubKeyToAddr(pub);
        } else {
            if (pk.length !== 64) {
                pk = zerextra.spendingKeyToSecretKey(pk); // pk = spendingKey
            }
            let secretKey = pk;
            let aPk = zerojs.zaddress.zSecretKeyToPayingKey(secretKey);
            let encPk = zerojs.zaddress.zSecretKeyToTransmissionKey(secretKey);
            addr = zerojs.zaddress.mkZAddress(aPk, encPk);
        }
        sqlRun("insert or ignore into wallet (pk, addr, lastbalance, name) values (?, ?, 0, ?)", pk, addr, name);
    } catch (err) {
        console.log(`Invalid private key on line in private keys file : `, err);
    }
}

async function apiGet(url) {
    const resp = await axiosApi(url);
    return resp.data;
}

async function apiPost(url, form) {
    const resp = await axiosApi.post(url, querystring.stringify(form));
    return resp.data;
}

async function fetchTransactions(txIds, myAddrs) {
    const txs = [];
    const myAddrSet = new Set(myAddrs);

    for (const txId of txIds) {
        const info = await apiGet("tx/" + txId);

        let txBalance = 0;
        const vins = [];
        const vouts = [];

        // Address field in transaction rows is meaningless. Pick something sane.
        let firstMyAddr;

        for (const vout of info.vout) {
            // XXX can it be something else?
            if (!vout.scriptPubKey) {
                continue;
            }
            let balanceAccounted = false;
            for (const addr of vout.scriptPubKey.addresses) {
                if (!balanceAccounted && myAddrSet.has(addr)) {
                    balanceAccounted = true;
                    txBalance += parseFloat(vout.value);
                    if (!firstMyAddr) {
                        firstMyAddr = addr;
                    }
                }
                if (!vouts.includes(addr)) {
                    vouts.push(addr);
                }
            }
        }

        for (const vin of info.vin) {
            const addr = vin.addr;
            if (myAddrSet.has(addr)) {
                txBalance -= parseFloat(vin.value);
                if (!firstMyAddr) {
                    firstMyAddr = addr;
                }
            }
            if (!vins.includes(addr)) {
                vins.push(addr);
            }
        }

        const tx = {
            txid: info.txid,
            time: info.blocktime,
            address: firstMyAddr,
            vins: vins.join(","),
            vouts: vouts.join(","),
            amount: txBalance,
            block: info.blockheight
        };

        txs.push(tx);
    }

    return txs;
}

async function fetchBlockchainChanges(addrObjs, knownTxIds) {
    const result = {
        changedAddrs: [],
        newTxs: []
    };
    const txIdSet = new Set();

    for (const obj of addrObjs) {
        const info = await apiGet("/addr/" + obj.addr);
        if (obj.lastbalance !== info.balance) {
            obj.balanceDiff = info.balance - (obj.lastbalance || 0);
            obj.lastbalance = info.balance;
            result.changedAddrs.push(obj);
        }
        info.transactions.forEach(txId => txIdSet.add(txId));
    }

    knownTxIds.forEach(txId => txIdSet.delete(txId));

    const newTxs = await fetchTransactions([...txIdSet], addrObjs.map(obj => obj.addr));
    result.newTxs = new List(newTxs).sortBy(tx => tx.block).toArray();

    return result;
}

async function updateBlockchainView(webContents) {
    webContents.send("add-loading-image");
    const addrObjs = sqlSelectObjects("SELECT addr, name, lastbalance FROM wallet where length(addr)=35");
    const knownTxIds = sqlSelectColumns("SELECT DISTINCT txid FROM transactions").map(row => row[0]);
    let totalBalance = addrObjs.filter(obj => obj.lastbalance).reduce((sum, a) => sum + a.lastbalance, 0);

    let result;
    try {
        result = await fetchBlockchainChanges(addrObjs, knownTxIds);
    } catch (e) {
        console.log("Update from API failed", e);
        return;
    }

    for (const addrObj of result.changedAddrs) {
        sqlRun("UPDATE wallet SET lastbalance = ? WHERE addr = ?", addrObj.lastbalance, addrObj.addr);
        totalBalance += addrObj.balanceDiff;
        webContents.send("update-wallet-balance", JSON.stringify({
            response: "OK",
            addrObj: addrObj,
            diff: addrObj.balanceDiff,
            total: totalBalance
        }));
    }

    const zAddrObjs = sqlSelectObjects("SELECT addr, name, lastbalance,pk FROM wallet where length(addr)=95");

    for (const addrObj of zAddrObjs) {
        let previousBalance;
        if (!(oldZAddrJSON === undefined || oldZAddrJSON === {})) {
            // TODO: Should do something with this
            previousBalance = oldZAddrJSON[addrObj.addr];
        } else {
            previousBalance = 0.0;
        }
        let balance;
        if (addrObj.lastbalance === "NaN" || addrObj.lastbalance === undefined) {
            balance = 0.0;
        } else {
            balance = addrObj.lastbalance;
        }
        let balanceDiff = balance - previousBalance;
        addrObj.lastbalance = balance;
        oldZAddrJSON[addrObj.addr] = balance;
        sqlRun("UPDATE wallet SET lastbalance = ? WHERE addr = ?", balance, addrObj.addr);
        // not balanceDiff here
        totalBalance += balance;
        if (!(balanceDiff === 0.00000000)) {
            webContents.send("update-wallet-balance", JSON.stringify({
                response: "OK",
                addrObj: addrObj,
                diff: balanceDiff,
                total: totalBalance
            }));
        }
    }

    // Why here ? In case balance is unchanged the 'update-wallet-balance' is never sent, but the Zer/Fiat balance will change.
    webContents.send("send-refreshed-wallet-balance", totalBalance);

    for (const tx of result.newTxs) {
        if (tx.block >= 0) {
            sqlRun("INSERT INTO transactions VALUES (?,?,?,?,?,?,?,?)", null, tx.txid, tx.time, tx.address, tx.vins, tx.vouts, tx.amount, tx.block);
        }
        webContents.send("get-transaction-update", JSON.stringify(tx));
    }
    webContents.send("remove-loading-image");
}

function sendWallet() {
    if (!userInfo.loggedIn) {
        return;
    }
    const resp = {};
    resp.response = "OK";
    resp.autorefresh = settings.autorefresh;
    resp.wallets = sqlSelectObjects("SELECT * FROM wallet ORDER BY lastbalance DESC, id DESC");
    resp.transactions = sqlSelectObjects("SELECT * FROM transactions ORDER BY time DESC LIMIT " + settings.txHistory);
    resp.total = resp.wallets.reduce((sum, a) => sum + a.lastbalance, 0);

    mainWindow.webContents.send("get-wallets-response", JSON.stringify(resp));
    updateBlockchainView(mainWindow.webContents);
}

function importPKs() {
    function importFromFile(filename) {
        let i = 1;
        fs.readFileSync(filename).toString().split("\n").filter(x => x).forEach(line => {
            const matches = line.match(/^\w+/);
            if (matches) {
                let pk = matches[0];
                importOnePK(pk, "");
            }
            i++;
        });
    }

    dialog.showMessageBox({
        type: "warning",
        title: "Important Information",
        message: tr("warmingMessages.userWarningImportFileWithPKs", userWarningImportFileWithPKs),
        buttons: [tr("warmingMessages.userWarningIUnderstand", "I understand"), tr("warmingMessages.cancel", "Cancel")],
        cancelId: -1
    }, function (response) {
        if (response === 0) {
            dialog.showOpenDialog({
                title: "Choose file with private keys"
            }, filenames => {
                if (filenames) {
                    for (let f of filenames) {
                        importFromFile(f);
                    }
                    // TODO: save only if at least one key was inserted
                    saveWallet();
                    sendWallet();
                }
            });
        }
    });
}

function changeWalletPasswordBegin() {
    mainWindow.webContents.send("change-wallet-password-begin", userInfo.pass);
}

function changeWalletPasswordContinue(newPassword) {
    let result = {};
    try {
        userInfo.pass = newPassword;
        saveWallet();
        result.success = true;
    }
    catch (e) {
        result.success = false;
        result.error = e;
    }
    mainWindow.webContents.send("change-wallet-password-finish", JSON.stringify(result));
}

function updateMenuForDarwin(template) {
    if (os.platform() === "darwin") {
        template.unshift({
            label: app.getName(),
            submenu: [
                {
                    role: "about"
                },
                {
                    type: "separator"
                },
                {
                    role: "services",
                    submenu: []
                },
                {
                    type: "separator"
                },
                {
                    role: "hide"
                },
                {
                    role: "hideothers"
                },
                {
                    role: "unhide"
                },
                {
                    type: "separator"
                },
                {
                    role: "quit"
                }
            ]
        });
    }
}

function createEditSubmenu() {
    return [
        {
            label: tr("menu.editSubmenu.undo", "Undo"),
            accelerator: "CmdOrCtrl+Z",
            selector: "undo:"
        },
        {
            label: tr("menu.editSubmenu.redo", "Redo"),
            accelerator: "Shift+CmdOrCtrl+Z",
            selector: "redo:"
        },
        {type: "separator"},
        {
            label: tr("menu.editSubmenu.cut", "Cut"),
            accelerator: "CmdOrCtrl+X",
            selector: "cut:"
        },
        {
            label: tr("menu.editSubmenu.copy", "Copy"),
            accelerator: "CmdOrCtrl+C",
            selector: "copy:"
        },
        {
            label: tr("menu.editSubmenu.paste", "Paste"),
            accelerator: "CmdOrCtrl+V",
            selector: "paste:"
        },
        {
            label: tr("menu.editSubmenu.selectAll", "Select All"),
            accelerator: "CmdOrCtrl+A",
            selector: "selectAll:"
        }
    ];
}

function createHelpSubmenu() {
    return [
        {
            label: tr("menu.helpSubmenu.arizenManual", "User Manual"),
            accelerator: "CmdOrCtrl+H",
            click: () => {
                require("electron").shell.openExternal("https://github.com/ProphetAlgorithms/zero-arizen#user-manuals");
            }
        },
        {
            label: tr("menu.helpSubmenu.support", "Support"),
            accelerator: "Shift+CmdOrCtrl+S",
            click: () => {
                require("electron").shell.openExternal("http://t.me/zerocurrency");
            }
        },
        {type: "separator"},
        {
            label: tr("menu.helpSubmenu.zencash", "Zero"),
            click: () => {
                require("electron").shell.openExternal("https://zerocurrency.io");
            }
        }
    ];
}

function includeDeveloperMenu(template) {
    if (process.env.NODE_ENV !== "production") {
        template.push({
            label: "Developer Tools",
            submenu: [
                {
                    label: "Toggle DevTools",
                    accelerator: process.platform === "darwin" ? "Command+I" : "Ctrl+I",
                    click(item, focusedWindow) {
                        focusedWindow.toggleDevTools();
                    }
                },
                {role: "reload"},
                {role: 'forcereload'},
                {type: 'separator'},
                {role: 'togglefullscreen'},
                {type: "separator"},
                {
                    label: tr("menu.backupUnencrypted", "Backup UNENCRYPTED wallet"),
                    click() {
                        exportWalletArizen("uawd", false);
                    }
                },
                {type: "separator"},
                {
                    label: "RPC console",
                    click() {
                        mainWindow.webContents.send("open-rpc-console");
                    }
                }
            ]
        })
    }
}

function updateMenuAtLogin() {
    const template = [
        {
            label: tr("menu.file", "File"),
            submenu: [
                {
                    label: tr("menu.backupEncrypted", "Backup ENCRYPTED wallet"),
                    click() {
                        exportWalletArizen("awd", true);
                    }
                },
                {
                    label: tr("menu.backupUnencrypted", "Backup UNENCRYPTED wallet"),
                    click() {
                        exportWalletArizen("uawd", false);
                    }
                },
                {type: "separator"},
                {
                    label: tr("menu.importEncrypted", "Import ENCRYPTED Arizen wallet"),
                    click() {
                        importWalletArizen("awd", true);
                    }
                },
                {
                    label: tr("menu.importUnencrypted", "Import UNENCRYPTED Arizen wallet"),
                    click() {
                        importWalletArizen("uawd", false);
                    }
                },
                {type: "separator"},
                {
                    label: tr("menu.exportPrivateKeys", "Export private keys"),
                    click: function () {
                        exportPKs();
                    }
                },
                {
                    label: tr("menu.importPrivateKeys", "Import private keys"),
                    click: function () {
                        importPKs();
                    }
                },
                {type: "separator"},
                {
                    label: tr("menu.changeWalletPassword", "Change wallet password"),
                    click() {
                        changeWalletPasswordBegin();
                    }
                },
                {type: "separator"},
                {
                    label: tr("menu.exit", "Exit"),
                    click() {
                        stopZeroNode();
                    }
                }
            ]
        },
        {
            label: tr("menu.edit", "Edit"),
            submenu: createEditSubmenu()
        },
        {
            label: tr("menu.help", "Help"),
            submenu: createHelpSubmenu()
        }
    ];

    updateMenuForDarwin(template);
    includeDeveloperMenu(template);

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function updateMenuAtLogout() {
    const template = [
        {
            label: tr("menu.file", "File"),
            submenu: [
                {
                    label: tr("menu.exit", "Exit"),
                    click() {
                        stopZeroNode();
                    }
                }
            ]
        },
        {
            label: tr("menu.edit", "Edit"),
            submenu: createEditSubmenu()
        },
        {
            label: tr("menu.help", "Help"),
            submenu: createHelpSubmenu()
        }
    ];
    updateMenuForDarwin(template);
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
    updateMenuAtLogout();
    mainWindow = new BrowserWindow({width: 1020, height: 730, resizable: true, icon: "resources/zer_icon.png"});

    // mainWindow.webContents.openDevTools();

    if (fs.existsSync(getWalletPath())) {
        mainWindow.loadURL(url.format({
            pathname: path.join(__dirname, "login.html"),
            protocol: "file:",
            slashes: true
        }));
    } else {
        mainWindow.loadURL(url.format({
            pathname: path.join(__dirname, "create_wallet.html"),
            protocol: "file:",
            slashes: true
        }));
    }

    // Emitted when the window is closed.
    mainWindow.on("closed", function () {
        // Dereference the window object, usually you would store windows
        // in an array if your app supports multi windows, this is the time
        // when you should delete the corresponding element.
        mainWindow = null;
    });
}

// https://github.com/electron/electron/issues/6139
if (process.platform === "linux") {
    app.disableHardwareAcceleration();
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on("ready", () => createWindow());

// Quit when all windows are closed.
app.on("window-all-closed", function () {
    stopZeroNode();
});

app.on("activate", function () {
    // On macOS it"s common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (mainWindow === null) {
        createWindow();
        // checkAll();
    }
});

app.on("before-quit", function () {
    console.log("quitting");
    if (true === userInfo.loggedIn && true === userInfo.dbChanged) {
        saveWallet();
    }
});

ipcMain.on("set-lang", function (event, lang) {
    langDict = require("./lang/lang_" + lang + ".json");
    updateMenuAtLogin();
});

ipcMain.on("write-login-info", function (event, data) {
    let inputs = JSON.parse(data);
    let resp = {
        response: "ERR",
        msg: ""
    };
    let path = getWalletPath();

    /* create wallet path if necessary */
    if (!fs.existsSync(path)) {
        fs.mkdirSync(path);
    }

    path += inputs.username + ".awd";
    /* check if user exists */
    if (!fs.existsSync(path)) {
        if (inputs.walletPath !== "") {
            if (fs.existsSync(inputs.walletPath)) {
                let walletBytes = [];
                if (inputs.encrypted) {
                    walletBytes = decryptWallet(inputs.olduser, inputs.oldpass, inputs.walletPath);
                    if (walletBytes === -1) {
                        resp.msg = "Data import failed, possible reason is wrong credentials or file is corrupted";
                    } else if (data === -2) {
                        resp.msg = "Data import failed, possible reason is wrong credentials";
                    } else {
                        resp.msg = "Wallet decrypt failed";
                    }
                } else {
                    walletBytes = fs.readFileSync(inputs.walletPath);
                    resp.msg = "Wallet read failed";
                }
                if (walletBytes.length > 1) {
                    let db = new sql.Database(walletBytes);
                    let walletEncrypted = encryptWallet(inputs.username, inputs.password, db.export());
                    storeFile(path, walletEncrypted);
                    resp.response = "OK";
                    resp.msg = "";
                }
            } else {
                resp.msg = "Original file is missing";
            }
        } else {
            generateNewWallet(inputs.username, inputs.password);
            resp.response = "OK";
        }
    } else {
        resp.msg = "User is already registered";
    }
    event.sender.send("write-login-response", JSON.stringify(resp));
});

ipcMain.on("verify-login-info", function (event, login, pass) {
    let resp;
    let path = getWalletPath() + login + ".awd";

    if (fs.existsSync(path)) {
        let walletBytes = decryptWallet(login, pass, path);
        if (walletBytes === -1) {
            resp = {
                response: "ERR_corrupted_file"
            };
        } else if (walletBytes === -2) {
            resp = {
                response: "ERR_wrong_credentials"
            };
        } else if (walletBytes.length > 1) {
            userInfo.loggedIn = true;
            userInfo.login = login;
            userInfo.pass = pass;
            userInfo.walletDb = new sql.Database(walletBytes);
            upgradeDb();
            setSettings(loadSettings());
            setInternalInfo(loadInternalInfo());
            updateMenuAtLogin();
            resp = {
                response: "OK",
                user: login
            };
            if (nodeAlive === 0) {
               checkZeroFilesAndStart();
            }
        }
    } else {
        resp = {
            response: "ERR_nonexistent_wallet_name"
        };
    }

    event.sender.send("verify-login-response", JSON.stringify(resp));
});

ipcMain.on("check-login-info", function (event) {
    let resp = {
        response: "ERR",
        user: ""
    };

    if (userInfo.loggedIn) {
        resp.response = "OK";
        resp.user = userInfo.login;
    }
    event.sender.send("check-login-response", JSON.stringify(resp));
});

ipcMain.on("do-logout", function () {
    updateMenuAtLogout();
    if (true === userInfo.dbChanged) {
        saveWallet();
    }
    userInfo.login = "";
    userInfo.pass = "";
    userInfo.walletDb = [];
    userInfo.loggedIn = false;
});

ipcMain.on("exit-from-menu", function () {
    stopZeroNode();
});

function importSingleKey(name, pk, isT) {
    importOnePK(pk, name, isT);
    saveWallet();
    sendWallet();
}

ipcMain.on("import-single-key", function (event, name, pk, isT) {
    importSingleKey(name, pk, isT);
});

ipcMain.on("import-single-key-Sync", function (event, name, pk, isT) {
    importSingleKey(name, pk, isT);
    event.returnValue = true;
});

ipcMain.on("get-wallets", () => {
    mainWindow.webContents.send("settings", JSON.stringify(settings));
    mainWindow.webContents.send("internal-info", JSON.stringify(internalInfo));
    sendWallet();
});

ipcMain.on("refresh-wallet", function (event) {
    let resp = {response: "ERR"};

    if (userInfo.loggedIn) {
        updateBlockchainView(event.sender);
        resp.response = "OK";
        resp.autorefresh = settings.autorefresh;
    }

    event.sender.send("refresh-wallet-response", JSON.stringify(resp));
});

ipcMain.on("rename-wallet", function (event, address, name) {
    let resp = {
        response: "ERR",
        msg: "not logged in"
    };

    if (userInfo.loggedIn) {
        const count = sqlSelectColumns("SELECT count(*) FROM wallet WHERE addr = ?", address)[0][0];
        if (count) {
            sqlRun("UPDATE wallet SET name = ? WHERE addr = ?", name, address);
            saveWallet();
            resp = {
                response: "OK",
                msg: "address " + address + " set to " + name,
                addr: address,
                newname: name
            };
        } else {
            resp.msg = "address not found";
        }
    }
    event.sender.send("rename-wallet-response", JSON.stringify(resp));
});

ipcMain.on("get-wallet-by-name", function (event, name) {
    let resp = {
        response: "ERR",
        msg: "not logged in"
    };

    if (userInfo.loggedIn) {
        const walletAddr = sqlSelectObjects("SELECT * FROM wallet WHERE name = ?", name)[0];
        if (walletAddr) {
            resp = {
                response: "OK",
                wallets: walletAddr
            };
        } else {
            resp.msg = "name not found";
        }
    }
    event.sender.send("get-wallet-by-name-response", JSON.stringify(resp));
});

ipcMain.on("generate-wallet", function (event, name) {
    let resp = {
        response: "ERR",
        msg: "not logged in"
    };

    if (userInfo.loggedIn) {
        resp.response = "OK";
        resp.addr = getNewAddress(name);
    }

    event.sender.send("generate-wallet-response", JSON.stringify(resp));
});

ipcMain.on("save-settings", function (event, newSettingsStr) {
    if (!userInfo.loggedIn) {
        return;
    }
    const newSettings = JSON.parse(newSettingsStr);
    saveSettings(newSettings);
    setSettings(newSettings);
    event.sender.send("save-settings-response", JSON.stringify({response: "OK"}));
    event.sender.send("settings", newSettingsStr);
});

ipcMain.on("save-internal-info", function (event, newInternalInfoStr) {
    if (!userInfo.loggedIn) {
        return;
    }
    const newInternalInfo = JSON.parse(newInternalInfoStr);
    saveInternalInfo(newInternalInfo);
    setInternalInfo(newInternalInfo);
    //event.sender.send("save-settings-response", JSON.stringify({response: "OK"}));
    event.sender.send("internalInfo", newInternalInfoStr);
});

ipcMain.on("show-notification", function (event, title, message, duration) {
    if (settings.notifications === 1) {
        event.sender.send("show-notification-response", title, message, duration);
    } else {
        console.log(title + ": " + message);
    }
});

ipcMain.on("check-if-address-in-wallet", function (event, address) {
    let exist = false;
    let result = sqlSelectObjects("Select * from wallet"); // where length(addr)=35 //take only T addresses // or ("Select * from wallet where addr = ?", [zAddress]);
    for (let k of result) {
        if (k.addr === address) {
            exist = true;
            break;
        }
    }
    event.returnValue = {exist: exist, result: result};
});

ipcMain.on("change-wallet-password-continue", (event, newPassword) => {
    changeWalletPasswordContinue(newPassword);
});

function checkSendParameters(fromAddresses, toAddresses, fee) {
    let errors = [];

    for (const fromAddress of fromAddresses) {
        if (fromAddress.length !== 35) {
            errors.push(tr("wallet.tabWithdraw.messages.fromAddressBadLength", "Bad length of the source address!"));
        }

        if (fromAddress.substring(0, 2) !== "t1") {
            errors.push(tr("wallet.tabWithdraw.messages.fromAddressBadPrefix", "Bad source address prefix - it has to be 't1'!"));
        }
    }

    for (const toAddress of toAddresses) {
        if (toAddress.length !== 35) {
            errors.push(tr("wallet.tabWithdraw.messages.toAddressBadLength", "Bad length of the destination address!"));
        }

        if (toAddress.substring(0, 2) !== "t1") {
            errors.push(tr("wallet.tabWithdraw.messages.toAddressBadPrefix", "Bad destination address prefix - it has to be 't1'!"));
        }
    }

    if (typeof parseInt(fee, 10) !== "number" || fee === "") {
        errors.push(tr("wallet.tabWithdraw.messages.feeNotNumber", "Fee is NOT a number!"));
    }

    // fee can be zero, in block can be few transactions with zero fee
    if (fee < 0) {
        errors.push(tr("wallet.tabWithdraw.messages.feeIsNegative", "Fee has to be greater than or equal to zero!"));
    }

    return errors;
}

function checkStandardSendParameters(fromAddress, toAddress, fee, amount) {
    let errors = checkSendParameters([fromAddress], [toAddress], fee);

    if (typeof parseInt(amount, 10) !== "number" || amount === "") {
        errors.push(tr("wallet.tabWithdraw.messages.amountNotNumber", "Amount is NOT a number"));
    }

    if (amount <= 0) {
        errors.push(tr("wallet.tabWithdraw.messages.amountIsZero", "Amount has to be greater than zero!"));
    }

    return errors;
}

function checkBatchSplitParameters(fromAddresses, toAddress, fee, splitTo) {
    let errors = checkSendParameters(fromAddresses, [toAddress], fee);

    if (splitTo <= 0) {
        errors.push(tr("wallet.batchSplit.messages.splitToIsZero", "Split to amounts have to be greater than zero!"));
    }

    return errors;
}

function checkBatchWithdrawParameters(fromAddresses, toAddress, fee, thresholdLimit) {
    let errors = checkSendParameters(fromAddresses, [toAddress], fee);

    if (thresholdLimit < 0) {
        errors.push(tr("wallet.tabWithdraw.messages.amountIsZero", "Threshold limit has to be greater than or equal to zero!"));
    }

    return errors;
}

ipcMain.on("send", async function (event, fromAddress, toAddress, fee, amount) {
    let paramErrors = checkStandardSendParameters(fromAddress, toAddress, fee, amount);
    if (paramErrors.length) {
        // TODO: Come up with better message. For now, just make a HTML out of it.
        const errString = paramErrors.join("<br/>\n\n");
        event.sender.send("send-finish", "error", errString);
        return;
    }

    try {
        // Convert to satoshi
        let amountInSatoshi = Math.round(amount * 100000000);
        let feeInSatoshi = Math.round(fee * 100000000);
        let err = "";
        let walletAddr = sqlSelectObjects("SELECT * FROM wallet WHERE addr = ?", fromAddress)[0];

        if (!walletAddr) {
            err = tr("wallet.tabWithdraw.messages.unknownAddress", "Source address is not in your wallet!");
            event.sender.send("send-finish", "error", err);
            return;
        }

        if (walletAddr.lastbalance < (parseFloat(amount) + parseFloat(fee))) {
            err = tr("wallet.tabWithdraw.messages.insufficientFundsSourceAddr", "Insufficient funds on source address!");
            event.sender.send("send-finish", "error", err);
            return;
        }

        let privateKey = walletAddr.pk;

        const prevTxURL = "/addr/" + fromAddress + "/utxo";
        const infoURL = "/status?q=getInfo";
        const sendRawTxURL = "/tx/send";

        // Building our transaction TXOBJ
        // Calculate maximum ZER satoshis that we have
        let satoshisSoFar = 0;
        let history = [];
        let recipients = [{address: toAddress, satoshis: amountInSatoshi}];

        const txData = await apiGet(prevTxURL);
        const infoData = await apiGet(infoURL);

        const blockHeight = infoData.info.blocks - 300;
        const blockHashURL = "/block-index/" + blockHeight;

        const blockHash = (await apiGet(blockHashURL)).blockHash;

        // Iterate through each utxo and append it to history
        for (let i = 0; i < txData.length; i++) {
            if (txData[i].confirmations === 0) {
                continue;
            }

            if (txData[i].isCoinbase) {
                err = tr("wallet.tabWithdraw.messages.isCoinbaseUTXO", "Your address contains newly mined coins, also called coinbase unspent transaction outputs (coinbase UTXO). These need to be shielded and unshielded first before they can be spent, please import the private key of this address into a full wallet like Swing and then send all your coins from this address to a Z-address and then back to this T-address. You will be then able to spend them in Zero Arizen as well.");
                event.sender.send("send-finish", "error", err);
                return;
            }

            history = history.concat({
                txid: txData[i].txid,
                vout: txData[i].vout,
                scriptPubKey: txData[i].scriptPubKey
            });

            // How many satoshis we have so far
            satoshisSoFar = satoshisSoFar + txData[i].satoshis;
            if (satoshisSoFar >= amountInSatoshi + feeInSatoshi) {
                break;
            }
        }

        // If we don't have enough address - fail and tell it to the user
        if (satoshisSoFar < amountInSatoshi + feeInSatoshi) {
            err = tr("wallet.tabWithdraw.messages.insufficientFundsSourceAddr", "Insufficient funds on source address!");
            event.sender.send("send-finish", "error", err);
            return;
        }

        // If we don't have exact amount - refund remaining to current address
        if (satoshisSoFar !== (amountInSatoshi + feeInSatoshi)) {
            let refundSatoshis = satoshisSoFar - amountInSatoshi - feeInSatoshi;
            recipients = recipients.concat({address: fromAddress, satoshis: refundSatoshis});
        }

        // Create transaction
        let txObj = zerojs.transaction.createRawTx(history, recipients, blockHeight, blockHash);

        // Sign each history transcation
        for (let i = 0; i < history.length; i++) {
            txObj = zerojs.transaction.signTx(txObj, i, privateKey, true);
        }

        // Convert it to hex string
        const txHexString = zerojs.transaction.serializeTx(txObj);
        const txRespData = await apiPost(sendRawTxURL, {rawtx: txHexString});

        let message = "TXid:\n\n<small>" + txRespData.txid + "</small><br /><a href=\"javascript:void(0)\" onclick=\"openUrl('" + settings.explorerUrl + "/tx/" + txRespData.txid + "')\" class=\"walletListItemDetails transactionExplorer\" target=\"_blank\">Show Transaction in Explorer</a>";
        event.sender.send("send-finish", "ok", message);
    }
    catch (e) {
        event.sender.send("send-finish", "error", e.message);
        console.log(e);
    }
});

/**
 * Filters out all zero balanced wallets
 * @param fromAddressesAll - all selected addresses
 * @param thresholdLimit - threshold limit, eg 42
 * @returns {Array} - filtered non-zero addresses
 */
function filterOutZeroAddresses(fromAddressesAll, thresholdLimit) {
    let fromAddresses = [];

    for (let i = 0; i < fromAddressesAll.length; i++) {
        let walletAddr = sqlSelectObjects("SELECT * FROM wallet WHERE addr = ?", fromAddressesAll[i])[0];
        if (walletAddr) {
            if (walletAddr.lastbalance !== 0 && walletAddr.lastbalance > thresholdLimit) {
                fromAddresses.push(fromAddressesAll[i]);
            }
        }
    }

    return fromAddresses
}

/**
 * @param fromAddresses - array of addresses
 * @returns {string} - returns string of addresses
 */
function getPreviousTxURL(fromAddresses) {
    let prevTxURLs = [];
    let prefix = "/addrs/";
    let prevTxURL = prefix;
    let notModulo = false;

    for (let i = 1; i < fromAddresses.length + 1; i++) {
        if (i % 10 === 0) {
            prevTxURL += fromAddresses[i - 1];
            prevTxURL += "/utxo";
            prevTxURLs = prevTxURLs.concat(prevTxURL);
            prevTxURL = prefix;
            notModulo = false;
        } else {
            prevTxURL += fromAddresses[i - 1] + ",";
            notModulo = true;
        }
    }

    if (notModulo) {
        prevTxURL = prevTxURL.substring(0, prevTxURL.length - 1);
        prevTxURL += "/utxo";
        prevTxURLs = prevTxURLs.concat(prevTxURL);
    }

    return prevTxURLs
}

/**
 * Iterate through each UTXO and append it to history specifically to every mapped address
 * @param event - for throwing error
 * @param txData - transaction data
 * @param addrPk {Map<string, string>} - {Map<address, PK>}
 * @returns {Map<string, Object>} - Map<address, Object> for better data storage and use
 */
function generateMap(event, txData, addrPk) {
    let map = new Map();
    let walletId = 0;

    for (let i = 0; i < txData.length; i++) {
        if (txData[i].confirmations === 0) {
            continue;
        }

        if (txData[i].isCoinbase) {
            let err = tr("wallet.tabWithdraw.messages.isCoinbaseUTXO", "Your address contains newly mined coins, also called coinbase unspent transaction outputs (coinbase UTXO). These need to be shielded and unshielded first before they can be spent, please import the private key of this address into a full wallet like Swing and then send all your coins from this address to a Z-address and then back to this T-address. You will be then able to spend them in Arizen as well.");
            event.sender.send("send-finish", "error", err);
            return;
        }

        // if exist in Map, then edit, if not, then create
        if (map.has(txData[i].address)) {
            map.get(txData[i].address).satoshis += txData[i].satoshis;
            map.get(txData[i].address).history = map.get(txData[i].address).history.concat({
                txid: txData[i].txid,
                vout: txData[i].vout,
                scriptPubKey: txData[i].scriptPubKey
            });
        } else {
            let obj = {
                id: walletId,
                pk: addrPk.get(txData[i].address),
                satoshis: txData[i].satoshis,
                history: [{
                    txid: txData[i].txid,
                    vout: txData[i].vout,
                    scriptPubKey: txData[i].scriptPubKey
                }]
            };
            map.set(txData[i].address, obj);
            walletId += 1;
        }
    }

    return map
}

/**
 *
 * @param event
 * @param start
 * @param nAddress
 * @param data
 * @param thresholdLimitInSatoshi
 * @param feeInSatoshi
 * @param toAddress
 * @param blockHeight
 * @param blockHash
 */
function calculateForNaddress(event, start, nAddress, data, thresholdLimitInSatoshi, feeInSatoshi, toAddress, blockHeight, blockHash) {
    let history = [];
    let err = "";

    let amountInSatoshiToSend = 0.0;
    amountInSatoshiToSend -= feeInSatoshi;

    for (let value of data.values()) {
        if (value.id >= start) {
            if (value.id === (start + nAddress)) {
                break
            }
            amountInSatoshiToSend += (value.satoshis - thresholdLimitInSatoshi);
        }
    }

    if (amountInSatoshiToSend <= 0.0) {
        err = tr("wallet.tabWithdraw.messages.sumLowerThanFee", "Your summed balance over all source addresses is lower than the fee!");
        event.sender.send("send-finish", "error", err);
        return;
    }

    let recipients = [{address: toAddress, satoshis: amountInSatoshiToSend}];

    for (let [key, value] of data.entries()) {
        if (value.id >= start) {
            if (value.id === (start + nAddress)) {
                break
            }

            // Refund thresholdLimitInSatoshi amount to current address
            if (thresholdLimitInSatoshi > 0) {
                recipients = recipients.concat({
                    address: key,
                    satoshis: thresholdLimitInSatoshi
                });
            }

            value.history.forEach(function(h) {
                history = history.concat(h);
            });
        }
    }

    // Create transaction
    let txObj = zerojs.transaction.createRawTx(history, recipients, blockHeight, blockHash);

    // Sign history/transaction with PKs
    let j = 0;
    for (let value of data.values()) {
        if (value.id >= start) {
            if (value.id === (start + nAddress)) {
                break
            }

            for (let i = 0; i < value.history.length; i++) {
                txObj = zerojs.transaction.signTx(txObj, j, value.pk, true);
                j += 1;
            }
        }
    }

    // Convert it to hex string
    return zerojs.transaction.serializeTx(txObj);
}

/**
 *
 * @param event
 * @param txData
 * @param thresholdLimitInSatoshi
 * @param feeInSatoshi
 * @param toAddress
 * @param blockHeight
 * @param blockHash
 * @param addrPk
 */
function getMaxTxHexStrings(event, txData, thresholdLimitInSatoshi, feeInSatoshi, toAddress, blockHeight, blockHash, addrPk) {
    // API request limit, URL length
    const maxKbSize = 100;
    let txHexStrings = [];
    let err = "";
    let start = 0;
    let nAddrToValidate = 1;
    let nAddrProcessed = 0;
    let booster = 25;
    let boosterEnabled = false;

    // prepare data
    let data = generateMap(event, txData, addrPk);

    // Enable booster if there are many addresses
    if (data.size >= booster) {
        nAddrToValidate = booster;
        boosterEnabled = true;
    }

    while (true) {
        let txHexString = calculateForNaddress(event, start, nAddrToValidate, data, thresholdLimitInSatoshi, feeInSatoshi, toAddress, blockHeight, blockHash);

        if ((Buffer.byteLength(txHexString, "utf8") / 1024) > maxKbSize) {
            if (nAddrToValidate === 1) {
                err = tr("wallet.tabWithdraw.messages.tooManyUTXOs", "Your address consists of too many UTXOs, it is not possible to send this transaction via API!");
                event.sender.send("send-finish", "error", err);
            }

            if (boosterEnabled) {
                nAddrToValidate = 1;
                boosterEnabled = false;
            } else {
                txHexStrings = txHexStrings.concat(calculateForNaddress(event, start, nAddrToValidate - 1, data, thresholdLimitInSatoshi, feeInSatoshi, toAddress, blockHeight, blockHash));
                start = nAddrProcessed;

                nAddrToValidate = ((start + booster) < data.size) ? booster : 1;
                boosterEnabled = ((start + booster) < data.size);
            }
        } else {
            nAddrProcessed += boosterEnabled ? booster : 1;
            nAddrToValidate += 1;
            boosterEnabled = false;
        }

        // while terminal condition
        if (data.size === nAddrProcessed) {
            txHexStrings = txHexStrings.concat(txHexString);
            break
        }
    }

    return txHexStrings
}

/**
 * @param event
 * @param {array} fromAddressesAll - Array of strings, array of ZER addresses
 * @param toAddress - one destination ZER address
 * @param fee - fee for the whole transaction
 * @param thresholdLimit - How many ZERs will remain in every fromAddresses
 */
ipcMain.on("send-many", async function (event, fromAddressesAll, toAddress, fee, thresholdLimit = 42.0) {
    let paramErrors = checkBatchWithdrawParameters(fromAddressesAll, toAddress, fee, thresholdLimit);
    if (paramErrors.length) {
        // TODO: Come up with better message. For now, just make a HTML out of it.
        const errString = paramErrors.join("<br/>\n\n");
        event.sender.send("send-finish", "error", errString);
        return;
    }

    try {
        // -------------------------------------------------------------------------------------------------------------
        // Variables
        const infoURL = "/status?q=getInfo";
        const sendRawTxURL = "/tx/send";
        let finalMessage = "";
        // <address, PK> pairs
        let addrPk = new Map();
        let err = "";
        const satoshi = 100000000;
        let feeInSatoshi = Math.round(fee * satoshi);
        let thresholdLimitInSatoshi = Math.round(thresholdLimit * satoshi);
        let fromAddresses = filterOutZeroAddresses(fromAddressesAll, thresholdLimit);

        // check if there isn't any address with a balance
        if(fromAddresses.length === 0){
            err = tr("wallet.tabWithdraw.messages.noSourceAddress", "No source address was selected!");
            event.sender.send("send-finish", "error", err);
        }

        for (let i = 0; i < fromAddresses.length; i++) {
            let walletAddr = sqlSelectObjects("SELECT * FROM wallet WHERE addr = ?", fromAddresses[i])[0];

            if (!walletAddr) {
                err = tr("wallet.tabWithdraw.messages.unknownAddress", "Source address is not in your wallet!");
                event.sender.send("send-finish", "error", err);
                return;
            }

            addrPk.set(walletAddr.addr, walletAddr.pk);
        }

        if (addrPk.size !== fromAddresses.length) {
            err = tr("wallet.tabWithdraw.messages.numberOfKeys", "# private keys and # addresses are not equal!");
            event.sender.send("send-finish", "error", err);
            return;
        }

        // -------------------------------------------------------------------------------------------------------------
        // Get previous transactions
        const prevTxURLs = getPreviousTxURL(fromAddresses);
        let txData = [];
        for (let i = 0; i < prevTxURLs.length; i++) {
            txData = txData.concat(await apiGet(prevTxURLs[i]));
        }

        // -------------------------------------------------------------------------------------------------------------
        const infoData = await apiGet(infoURL);
        const blockHeight = infoData.info.blocks - 300;
        const blockHashURL = "/block-index/" + blockHeight;
        const blockHash = (await apiGet(blockHashURL)).blockHash;

        const txHexStrings = getMaxTxHexStrings(event, txData, thresholdLimitInSatoshi, feeInSatoshi, toAddress, blockHeight, blockHash, addrPk);

        for(let i = 0; i < txHexStrings.length; i++){
            const txRespData = await apiPost(sendRawTxURL, {rawtx: txHexStrings[i]});
            finalMessage += `<small><a href="javascript:void(0)" onclick="openUrl('${settings.explorerUrl}/tx/${txRespData.txid}')" class="walletListItemDetails transactionExplorer monospace" target="_blank">${txRespData.txid}</a>`;
            finalMessage += "</small><br/>\n\n";
        }

        event.sender.send("send-finish", "ok", finalMessage);
    }
    catch (e) {
        event.sender.send("send-finish", "error", e.message);
        console.log(e);
    }
});

/**
 *
 * @param event
 * @param txData
 * @param splitToInSatoshi
 * @param feeInSatoshi
 * @param toAddresses
 * @param blockHeight
 * @param blockHash
 * @param addrPk
 */
function getTxHexStringsForSplit(event, txData, toAddresses, splitToInSatoshi, feeInSatoshi, blockHeight, blockHash, addrPk) {
    let history = [];
    let err = "";

    // prepare data
    let data = generateMap(event, txData, addrPk);

    let amountInSatoshiToSend = 0.0;
    for (let value of data.values()) {
        amountInSatoshiToSend += value.satoshis;
    }
    amountInSatoshiToSend -= feeInSatoshi;

    if (amountInSatoshiToSend <= 0.0) {
        err = tr("wallet.tabWithdraw.messages.sumLowerThanFee", "Your summed balance over all source addresses is lower than the fee!");
        event.sender.send("send-finish", "error", err);
        return;
    }

    let recipients = [];

    let quotient = Math.floor(amountInSatoshiToSend / splitToInSatoshi);
    let remainder = amountInSatoshiToSend % splitToInSatoshi;

    if (remainder !== 0) {
        quotient += 1;
    }

    // if there is less/more addresses - refund the rest to the last address
    if (quotient !== toAddresses.length) {
        quotient = toAddresses.length;
    }

    let toAddress;
    for (let i = 0; i < quotient; i++) {
        toAddress = toAddresses[i];
        // refund the rest to the last address
        if (i === (quotient - 1)) {
            recipients = recipients.concat({
                address: toAddress,
                satoshis: (amountInSatoshiToSend - (i * splitToInSatoshi))
            });
        } else {
            recipients = recipients.concat({
                address: toAddress,
                satoshis: splitToInSatoshi
            });
        }
    }

    for (let value of data.values()) {
        value.history.forEach(function(h) {
            history = history.concat(h);
        });
    }

    // Create transaction
    let txObj = zencashjs.transaction.createRawTx(history, recipients, blockHeight, blockHash);

    // Sign history/transaction with PKs
    for (let value of data.values()) {
        for (let i = 0; i < history.length; i++) {
            txObj = zencashjs.transaction.signTx(txObj, i, value.pk, true);
        }
    }

    // Convert it to hex string
    return zencashjs.transaction.serializeTx(txObj);
}

ipcMain.on("split", async function (event, fromAddress, toAddresses, fee, splitTo = 42.0) {
    let paramErrors = checkBatchSplitParameters(toAddresses, fromAddress, fee, splitTo);
    if (paramErrors.length) {
        // TODO: Come up with better message. For now, just make a HTML out of it.
        const errString = paramErrors.join("<br/>\n\n");
        event.sender.send("send-finish", "error", errString);
        return;
    }

    try {
        // -------------------------------------------------------------------------------------------------------------
        // Variables
        const infoURL = "/status?q=getInfo";
        const sendRawTxURL = "/tx/send";
        let finalMessage = "";
        // <address, PK> pairs
        let addrPk = new Map();
        let err = "";
        const satoshi = 100000000;
        let feeInSatoshi = Math.round(fee * satoshi);
        let splitToInSatoshi = Math.round(splitTo * satoshi);

        // check if an address has been selected
        if(fromAddress === ""){
            err = tr("wallet.tabWithdraw.messages.noSourceAddress", "No source address was selected!");
            event.sender.send("send-finish", "error", err);
        }

        let walletAddr = sqlSelectObjects("SELECT * FROM wallet WHERE addr = ?", fromAddress)[0];
        if (!walletAddr) {
            err = tr("wallet.tabWithdraw.messages.unknownAddress", "One of your destination address is not in your wallet!");
            event.sender.send("send-finish", "error", err);
            return;
        }
        addrPk.set(walletAddr.addr, walletAddr.pk);

        // -------------------------------------------------------------------------------------------------------------
        // Get previous transactions
        const prevTxURL = "/addrs/" + fromAddress + "/utxo";
        let txData = await apiGet(prevTxURL);

        // -------------------------------------------------------------------------------------------------------------
        const infoData = await apiGet(infoURL);
        const blockHeight = infoData.info.blocks - 300;
        const blockHashURL = "/block-index/" + blockHeight;
        const blockHash = (await apiGet(blockHashURL)).blockHash;

        const txHexString = getTxHexStringsForSplit(event, txData, toAddresses, splitToInSatoshi, feeInSatoshi, blockHeight, blockHash, addrPk);

        if ((Buffer.byteLength(txHexString, "utf8") / 1024) > 100) {
            err = tr("wallet.batchSplit.messages.tooManyInputsOutputs", "Your transaction contains too many inputs/outputs addresses, please try less address!");
            event.sender.send("send-finish", "error", err);
            return;
        }

        const txRespData = await apiPost(sendRawTxURL, {rawtx: txHexString});
        finalMessage += `<small><a href="javascript:void(0)" onclick="openUrl('${settings.explorerUrl}/tx/${txRespData.txid}')" class="walletListItemDetails transactionExplorer monospace" target="_blank">${txRespData.txid}</a>`;
        finalMessage += "</small><br/>\n\n";

        event.sender.send("send-finish", "ok", finalMessage);
    }
    catch (e) {
        event.sender.send("send-finish", "error", e.message);
        console.log(e);
    }
});

ipcMain.on("create-paper-wallet", (event, name, addToWallet) => {
    let wif;
    if (addToWallet) {
        const addr = getNewAddress(name);
        mainWindow.webContents.send("generate-wallet-response",
            JSON.stringify({response: "OK", addr: addr}));
        wif = addr.wif;
    } else {
        wif = generateNewAddress(1, userInfo.pass)[0];
    }
    mainWindow.webContents.send("export-paper-wallet", wif, name);
});

ipcMain.on("renderer-show-message-box", (event, msgStr, buttons) => {
    buttons = buttons.concat([tr("warmingMessages.cancel", "Cancel")]);
    dialog.showMessageBox({
        type: "warning",
        title: "Important Information",
        message: msgStr,
        buttons: buttons,
        cancelId: -1
    }, function (response) {
        event.returnValue = response;
    });
});

ipcMain.on("update-Z-old-balance", (event) => {
    // zAddrObjs
    oldZAddrJSON = {};
    let oldZAddrTmp = sqlSelectObjects("SELECT addr, name, lastbalance,pk FROM wallet where length(addr)=95");
    for (const addrObj of oldZAddrTmp) {
        oldZAddrJSON[addrObj.addr] = addrObj.lastbalance;
    }
    event.returnValue = true
});

ipcMain.on("get-all-Z-addresses", (event) => {
    // zAddrObjs
    event.returnValue = sqlSelectObjects("SELECT addr, name, lastbalance, pk FROM wallet where length(addr)=95");
});

ipcMain.on("update-addr-in-db", (event, addrObj) => {
    sqlRun("UPDATE wallet SET lastbalance = ? WHERE addr = ?", addrObj.lastbalance, addrObj.addr);
    event.returnValue = true;
});


ipcMain.on("get-address-object", (event, fromAddress) => {
    // addrObjs
    event.returnValue = sqlSelectObjects("SELECT * FROM wallet WHERE addr = ?", fromAddress)[0];
});

ipcMain.on("DB-insert-address", function (event, nameAddress, pkZaddress, zAddress) {
    let resp = {
        response: "ERR",
        msg: "not logged in"
    };

    if (userInfo.loggedIn) {
        resp.response = "OK";
        resp.addr = {addr: zAddress, name: nameAddress, lastbalance: 0, pk: pkZaddress};
        userInfo.walletDb.run("INSERT INTO wallet VALUES (?,?,?,?,?)", [null, pkZaddress, zAddress, 0, nameAddress]);
        saveWallet();
    }

    event.sender.send("generate-wallet-response", JSON.stringify(resp));
});
