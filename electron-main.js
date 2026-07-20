const { app, BrowserWindow } = require('electron');
const path = require('path');

app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('ignore-ssl-errors');

app.whenReady().then(function() {
  // Pasta do exe -> usada pelo simulator.js para cert.pem / key.pem
  process.env.APP_DIR = path.dirname(app.getPath('exe'));

  require('./simulator.js');

  setTimeout(function() {
    var win = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 900,
      minHeight: 640,
      title: 'ATCash Simulator',
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    win.webContents.session.setCertificateVerifyProc(function(req, cb) { cb(0); });
    win.maximize();
    win.loadURL('https://127.0.0.1:44333/');
  }, 1500);
});

app.on('window-all-closed', function() { app.quit(); });
