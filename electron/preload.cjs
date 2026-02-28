const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // Account CRUD
    getAccounts: () => ipcRenderer.invoke('account:get-all'),
    deleteAccount: (accountId) => ipcRenderer.invoke('account:delete', accountId),
    importRawAccounts: (rawText) => ipcRenderer.invoke('account:import-raw', rawText),

    // Verification & Validation
    verifySelected: (ids) => ipcRenderer.invoke('account:verify-selected', ids),
    validateSelected: (ids) => ipcRenderer.invoke('account:validate-selected', ids),
    fetchProfileBulk: (ids) => ipcRenderer.invoke('account:fetch-profile-bulk', ids),
    updateProject: (ids, project) => ipcRenderer.invoke('account:update-project', ids, project),
    openCsvDialog: () => ipcRenderer.invoke('dialog:open-csv'),

    // Browser Control
    openBrowser: (accountId) => ipcRenderer.invoke('account:open-browser', accountId),
    closeBrowser: (accountId) => ipcRenderer.invoke('account:close-browser', accountId),
    fetchProfile: (accountId) => ipcRenderer.invoke('account:fetch-profile', accountId),
    manualLogin: (accountId) => ipcRenderer.invoke('account:manual-login', accountId),
    importCookies: (accountId, cookieText) => ipcRenderer.invoke('account:import-cookies', accountId, cookieText),
    openExternal: (url) => ipcRenderer.invoke('app:open-external', url),

    // Marketplace
    scrapeKeywords: (params) => ipcRenderer.invoke('marketplace:scrape-keywords', params),
    scrapeLocations: (params) => ipcRenderer.invoke('marketplace:scrape-locations', params),

    // Location Database
    getSavedLocations: () => ipcRenderer.invoke('location:get-all'),
    saveLocations: (data) => ipcRenderer.invoke('location:save-bulk', data),
    deleteLocations: (ids) => ipcRenderer.invoke('location:delete', ids),

    // Keyword History
    getKeywordHistory: () => ipcRenderer.invoke('keyword:get-history'),
    deleteKeywordHistory: (id) => ipcRenderer.invoke('keyword:delete-history', id),
    deleteKeyword: (historyId, keyword) => ipcRenderer.invoke('keyword:delete-keyword', historyId, keyword),

    // Material Builder
    openImageDialog: () => ipcRenderer.invoke('dialog:open-images'),
    openImages: () => ipcRenderer.invoke('dialog:open-images'),
    openImageFolder: () => ipcRenderer.invoke('dialog:open-image-folder'),
    saveMaterials: (data) => ipcRenderer.invoke('material:save', data),
    getMaterials: () => ipcRenderer.invoke('material:get-all'),
    deleteAllMaterials: () => ipcRenderer.invoke('material:delete-all'),
    deleteMaterials: (ids) => ipcRenderer.invoke('material:delete', ids),

    // Progress listener (Main → Renderer)
    onProgressUpdate: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('account:progress-update', handler);
        return () => ipcRenderer.removeListener('account:progress-update', handler);
    },

    // Browser closed listener (Main → Renderer)
    onBrowserClosed: (callback) => {
        const handler = (_event, accountId) => callback(accountId);
        ipcRenderer.on('account:browser-closed', handler);
        return () => ipcRenderer.removeListener('account:browser-closed', handler);
    },

    // Dashboard
    getDashboardStats: () => ipcRenderer.invoke('dashboard:get-stats'),

    // Auto Posting Engine
    startPosting: (payload) => ipcRenderer.invoke('marketplace:start-posting', payload),
    stopPosting: (campaignId) => ipcRenderer.invoke('marketplace:stop-posting', campaignId),
    getPostingHistory: () => ipcRenderer.invoke('posting:get-history'),
    clearPostingHistory: () => ipcRenderer.invoke('posting:clear-history'),
    openUrlWithSession: (params) => ipcRenderer.invoke('open-url-with-session', params),
    deleteSelectedHistory: (ids) => ipcRenderer.invoke('posting:delete-selected', ids),

    // Posting real-time listeners (Main → Renderer)
    onPostingLog: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('posting:log', handler);
        return () => ipcRenderer.removeListener('posting:log', handler);
    },
    onPostingStatus: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('posting:status', handler);
        return () => ipcRenderer.removeListener('posting:status', handler);
    },

    // License System
    activateLicense: (email, password) => ipcRenderer.invoke('license:activate', email, password),
    checkLicense: () => ipcRenderer.invoke('license:check'),
    resetHWID: () => ipcRenderer.invoke('license:reset-hwid'),
    getLicenseCache: () => ipcRenderer.invoke('license:get-cache'),
    clearLicense: () => ipcRenderer.invoke('license:clear-cache'),
    getHWID: () => ipcRenderer.invoke('license:get-hwid'),
    openUrl: (url) => ipcRenderer.invoke('license:open-url', url),
    queryTrialUsage: () => ipcRenderer.invoke('trial:query-usage'),

    // App Settings
    getSettings: () => ipcRenderer.invoke('app:get-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('app:save-settings', settings),
    setFullscreen: (enabled) => ipcRenderer.invoke('app:set-fullscreen', enabled),

    // Campaign Persistence
    getCampaigns: () => ipcRenderer.invoke('campaign:get-all'),
    saveCampaigns: (campaigns) => ipcRenderer.invoke('campaign:save-all', campaigns),

    // Renew Listings (Auto Perbarui Tawaran)
    scanRenewItems: (accountIds) => ipcRenderer.invoke('renew:scan-items', accountIds),
    executeRenewItems: (payload) => ipcRenderer.invoke('renew:execute-items', payload),
    stopRenew: () => ipcRenderer.invoke('renew:stop'),
    onRenewProgress: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('renew:progress', handler);
        return () => ipcRenderer.removeListener('renew:progress', handler);
    },

    // Relist Items (Hapus & Tawarkan Ulang)
    scanRelistItems: (accountIds) => ipcRenderer.invoke('relist:scan-items', accountIds),
    executeRelistItems: (payload) => ipcRenderer.invoke('relist:execute-items', payload),
    stopRelist: () => ipcRenderer.invoke('relist:stop'),
    onRelistProgress: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('relist:progress', handler);
        return () => ipcRenderer.removeListener('relist:progress', handler);
    },

    // Delete Violating Items (Hapus Produk Melanggar)
    scanViolatingItems: (accountIds) => ipcRenderer.invoke('delete-violating:scan-items', accountIds),
    executeDeleteViolating: (payload) => ipcRenderer.invoke('delete-violating:execute-items', payload),
    stopDeleteViolating: () => ipcRenderer.invoke('delete-violating:stop'),
    onDeleteViolatingProgress: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('delete-violating:progress', handler);
        return () => ipcRenderer.removeListener('delete-violating:progress', handler);
    },

    // Optimization History (Renew/Relist/Delete persistence)
    saveOptimizeEntry: (entry) => ipcRenderer.invoke('optimize:save-entry', entry),
    getOptimizeHistory: () => ipcRenderer.invoke('optimize:get-history'),
    clearOptimizeHistory: () => ipcRenderer.invoke('optimize:clear-history'),

    // Account Health Check
    checkAccountHealth: () => ipcRenderer.invoke('account:check-health'),
    stopHealthCheck: () => ipcRenderer.invoke('account:stop-health-check'),
    onHealthCheckProgress: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('health-check-progress', handler);
        return () => ipcRenderer.removeListener('health-check-progress', handler);
    },
    onAccountStatusChanged: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('account-status-changed', handler);
        return () => ipcRenderer.removeListener('account-status-changed', handler);
    },

    // Scrape FB Groups
    startScrapeGroups: (payload) => ipcRenderer.invoke('group:start-scrape', payload),
    stopScrapeGroups: () => ipcRenderer.invoke('group:stop-scrape'),
    saveTargetGroups: (groups) => ipcRenderer.invoke('group:save-targets', groups),
    getTargetGroups: () => ipcRenderer.invoke('group:get-targets'),
    getScrapeGroupHistory: () => ipcRenderer.invoke('group:get-scrape-history'),
    deleteScrapeGroupHistory: (id) => ipcRenderer.invoke('group:delete-scrape-history', id),
    deleteGroupFromHistory: (historyId, groupId) => ipcRenderer.invoke('group:delete-group-from-history', historyId, groupId),
    onScrapeGroupProgress: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('group:scrape-progress', handler);
        return () => ipcRenderer.removeListener('group:scrape-progress', handler);
    },

    // Join FB Groups
    startJoinGroups: (payload) => ipcRenderer.invoke('group:start-join', payload),
    stopJoinGroups: () => ipcRenderer.invoke('group:stop-join'),
    onJoinGroupProgress: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('group:join-progress', handler);
        return () => ipcRenderer.removeListener('group:join-progress', handler);
    },

    // Post to FB Groups
    startPostGroups: (payload) => ipcRenderer.invoke('group:start-post', payload),
    stopPostGroups: () => ipcRenderer.invoke('group:stop-post'),
    onPostGroupProgress: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('group:post-progress', handler);
        return () => ipcRenderer.removeListener('group:post-progress', handler);
    },

    // Group Materials CRUD
    saveGroupMaterials: (materials) => ipcRenderer.invoke('group:save-materials', materials),
    getGroupMaterials: () => ipcRenderer.invoke('group:get-materials'),
    deleteGroupMaterials: (ids) => ipcRenderer.invoke('group:delete-materials', ids),

    // Group Campaigns CRUD
    saveGroupCampaigns: (campaigns) => ipcRenderer.invoke('group:save-campaigns', campaigns),
    getGroupCampaigns: () => ipcRenderer.invoke('group:get-campaigns'),

    // Group Campaign Execution
    startGroupCampaign: (payload) => ipcRenderer.invoke('group:start-campaign', payload),
    stopGroupCampaign: () => ipcRenderer.invoke('group:stop-campaign'),
    onGroupCampaignProgress: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('group:campaign-progress', handler);
        return () => ipcRenderer.removeListener('group:campaign-progress', handler);
    },
    onGroupCampaignLog: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('group:campaign-log', handler);
        return () => ipcRenderer.removeListener('group:campaign-log', handler);
    },
});
