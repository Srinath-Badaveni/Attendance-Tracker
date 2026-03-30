const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    syncAttendance: (rollNo) => ipcRenderer.invoke('sync-attendance', rollNo)
});
