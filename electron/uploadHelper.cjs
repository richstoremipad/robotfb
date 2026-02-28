// ============================================
// Facebook Photo Upload Engine
// Bypasses UI — uploads directly via FB's internal API
// ============================================
const path = require('path');
const fs = require('fs');

// Mime type lookup by extension
const MIME_MAP = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
};

/**
 * Extract fb_dtsg token from a logged-in Playwright page.
 * Tries multiple strategies (window object, DOM, raw HTML regex).
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<string|null>}
 */
async function extractFbDtsg(page) {
    return page.evaluate(() => {
        // Strategy 1: Window global
        if (window.DTSGInitData && window.DTSGInitData.token) return window.DTSGInitData.token;
        // Strategy 2: require module
        try {
            if (typeof require === 'function') {
                const m = require('DTSGInitData');
                if (m && m.token) return m.token;
            }
        } catch { }
        // Strategy 3: Hidden input
        const input = document.querySelector('input[name="fb_dtsg"]');
        if (input) return input.value;
        // Strategy 4: Raw HTML regex
        const html = document.documentElement.innerHTML;
        const m1 = html.match(/"DTSGInitData".*?"token":"([^"]+)"/);
        if (m1) return m1[1];
        const m2 = html.match(/fb_dtsg.*?value="([^"]+)"/);
        if (m2) return m2[1];
        return null;
    });
}

/**
 * Extract the c_user (UID) from the browser context cookies.
 *
 * @param {import('playwright').BrowserContext} context
 * @returns {Promise<string|null>}
 */
async function extractUid(context) {
    const cookies = await context.cookies('https://www.facebook.com');
    const cUser = cookies.find((c) => c.name === 'c_user');
    return cUser ? cUser.value : null;
}

/**
 * Upload a single photo to Facebook's internal photo upload API.
 * Uses the Marketplace composer endpoint for compatibility.
 *
 * @param {Object} options
 * @param {import('playwright').Page}           options.page     - Active logged-in Playwright page
 * @param {import('playwright').BrowserContext}  options.context  - The browser context (for cookies)
 * @param {string}                              options.filePath - Absolute path to image file
 * @param {string}                              [options.fbDtsg] - Pre-extracted fb_dtsg (optional, will extract if not provided)
 * @param {string}                              [options.uid]    - Pre-extracted c_user UID (optional, will extract if not provided)
 * @returns {Promise<{ success: boolean, photoID?: string, error?: string }>}
 */
async function uploadPhotoToFB({ page, context, filePath, fbDtsg, uid }) {
    try {
        // ── Validate file exists
        if (!fs.existsSync(filePath)) {
            return { success: false, error: `File tidak ditemukan: ${filePath}` };
        }

        // ── Get credentials if not provided
        const token = fbDtsg || await extractFbDtsg(page);
        if (!token) {
            return { success: false, error: 'Gagal mengekstrak fb_dtsg token.' };
        }

        const userId = uid || await extractUid(context);
        if (!userId) {
            return { success: false, error: 'Gagal mengekstrak User ID (c_user).' };
        }

        // ── Determine mime type
        const ext = path.extname(filePath).toLowerCase();
        const mimeType = MIME_MAP[ext] || 'image/jpeg';
        const fileName = path.basename(filePath);

        // ── Read file into buffer
        const fileBuffer = fs.readFileSync(filePath);

        // ── Build upload URL with mandatory AJAX params
        const uploadUrl = `https://upload.facebook.com/ajax/react_composer/attachments/photo/upload?av=${userId}&__user=${userId}&__a=1&__req=1`;

        // ── Get real User-Agent from the browser page
        const userAgent = await page.evaluate(() => navigator.userAgent);

        console.log(`[UPLOAD] Uploading "${fileName}" (${(fileBuffer.length / 1024).toFixed(1)}KB) for UID ${userId}...`);

        // ── Send multipart request via Playwright context (carries cookies automatically)
        const response = await context.request.post(uploadUrl, {
            headers: {
                'Origin': 'https://www.facebook.com',
                'Referer': 'https://www.facebook.com/',
                'Accept': '*/*',
                'Sec-Fetch-Site': 'same-site',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Dest': 'empty',
                'User-Agent': userAgent,
            },
            multipart: {
                fb_dtsg: token,
                qn: 'comet_marketplace_composer',
                target_id: userId,
                source: '8',
                profile_id: userId,
                waterfallxapp: 'comet',
                farr: {
                    name: fileName,
                    mimeType: mimeType,
                    buffer: fileBuffer,
                },
            },
            timeout: 60000, // 60s timeout for large photos
        });

        // ── Enhanced debug: check HTTP status first
        const status = response.status();
        const rawText = await response.text();

        if (status !== 200) {
            console.log(`[UPLOAD DEBUG] HTTP Error ${status}. Raw Response:`, rawText.substring(0, 300));
            return { success: false, error: `HTTP ${status}: Upload ditolak oleh server.` };
        }

        if (!rawText || rawText.trim() === '') {
            console.log(`[UPLOAD DEBUG] Empty Response Body!`);
            return { success: false, error: 'Response body kosong dari server.' };
        }

        // ── Parse response with detailed error logging
        try {
            const cleanJson = rawText.replace('for (;;);', '').trim();
            const json = JSON.parse(cleanJson);

            // Extract photoID with multiple fallback paths
            const photoID = json?.payload?.fbid
                || json?.payload?.photoID
                || json?.payload?.photo_id
                || null;

            if (photoID) {
                console.log(`[UPLOAD] ✓ Photo uploaded: ${photoID}`);
                return { success: true, photoID: String(photoID) };
            }

            // Try deeper alternative paths
            const altPhotoID = json?.jsmods?.require?.[0]?.[3]?.[1]?.photoID
                || json?.jsmods?.require?.[0]?.[3]?.[1]?.fbid
                || null;

            if (altPhotoID) {
                console.log(`[UPLOAD] ✓ Photo uploaded (alt path): ${altPhotoID}`);
                return { success: true, photoID: String(altPhotoID) };
            }

            console.log(`[UPLOAD DEBUG] ID tidak ditemukan. JSON Parsed:`, JSON.stringify(json).substring(0, 400));
            return { success: false, error: 'Upload berhasil tapi photoID tidak ditemukan di respons.' };

        } catch (parseErr) {
            console.log(`[UPLOAD DEBUG] JSON Parse Error. Raw Text:`, rawText.substring(0, 400));
            return { success: false, error: `Gagal parsing respons: ${parseErr.message}` };
        }

    } catch (err) {
        console.error(`[UPLOAD] ✗ Error uploading "${path.basename(filePath)}":`, err.message);
        return { success: false, error: err.message || 'Upload gagal (unknown error).' };
    }
}

/**
 * Upload multiple photos sequentially.
 * Returns an array of photoIDs (or null for failed uploads).
 *
 * @param {Object} options
 * @param {import('playwright').Page}           options.page      - Active page
 * @param {import('playwright').BrowserContext}  options.context   - Browser context
 * @param {string[]}                            options.filePaths - Array of absolute paths
 * @param {Function}                            [options.onProgress] - Callback(index, total, result)
 * @returns {Promise<{ photoIDs: string[], errors: string[] }>}
 */
async function uploadMultiplePhotos({ page, context, filePaths, onProgress }) {
    const photoIDs = [];
    const errors = [];

    // Extract credentials once for all uploads
    const fbDtsg = await extractFbDtsg(page);
    const uid = await extractUid(context);

    if (!fbDtsg || !uid) {
        return {
            photoIDs: [],
            errors: [`Gagal mengekstrak kredensial: fbDtsg=${!!fbDtsg}, uid=${!!uid}`],
        };
    }

    console.log(`[UPLOAD] Batch uploading ${filePaths.length} photos...`);

    for (let i = 0; i < filePaths.length; i++) {
        const filePath = filePaths[i];
        const result = await uploadPhotoToFB({ page, context, filePath, fbDtsg, uid });

        if (result.success) {
            photoIDs.push(result.photoID);
        } else {
            errors.push(`[${path.basename(filePath)}] ${result.error}`);
            photoIDs.push(null); // Keep index alignment
        }

        if (onProgress) {
            onProgress(i + 1, filePaths.length, result);
        }

        // Small delay between uploads to avoid rate limiting
        if (i < filePaths.length - 1) {
            await new Promise((r) => setTimeout(r, 3000 + Math.random() * 3000));
        }
    }

    const successCount = photoIDs.filter(Boolean).length;
    console.log(`[UPLOAD] Batch complete: ${successCount}/${filePaths.length} berhasil.`);

    return { photoIDs, errors };
}

module.exports = {
    uploadPhotoToFB,
    uploadMultiplePhotos,
    extractFbDtsg,
    extractUid,
};
