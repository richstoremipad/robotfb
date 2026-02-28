// ============================================
// Facebook Marketplace Publish Engine (GraphQL API)
// Combines uploadHelper for photos + GraphQL mutation for listing
// ============================================
const path = require('path');
const fs = require('fs');

// ============================================
// Condition Mapper (UI Label → API Value)
// ============================================
function mapCondition(conditionName) {
    if (!conditionName) return 'new';
    if (conditionName.includes('Seperti Baru')) return 'used_like_new';
    if (conditionName.includes('Baik') && !conditionName.includes('Cukup')) return 'used_good';
    if (conditionName.includes('Cukup')) return 'used_fair';
    if (conditionName.includes('Baru')) return 'new';
    return 'used_fair';
}

const mapCategoryToFbId = (categoryName) => {
    if (!categoryName) return '895487550471874'; // Fallback ke "Lain-lain"

    const name = categoryName.trim().toLowerCase();

    // 25 KAMUS KATEGORI UTAMA FB
    const fbCategories = {
        'peralatan': '1670493229902393',
        'mebel': '1583634935226685',
        'peralatan rumah tangga': '1569171756675761',
        'kebun': '800089866739547',
        'perkakas': '678754142233400',
        'video game': '686977074745292',
        'buku, film, & musik': '613858625416355',
        'tas & koper': '1567543000236608',
        'pakaian & sepatu wanita': '1266429133383966',
        'pakaian & sepatu pria': '931157863635831',
        'perhiasan & aksesori': '214968118845643',
        'kesehatan & kecantikan': '1555452698044988',
        'kebutuhan hewan peliharaan': '1550246318620997',
        'bayi & anak-anak': '624859874282116',
        'mainan & game': '606456512821491',
        'elektronik & komputer': '1792291877663080',
        'telepon seluler': '1557869527812749',
        'sepeda': '1658310421102081',
        'seni & kerajinan': '1534799543476160',
        'olahraga & outdoor': '1383948661922113',
        'komponen otomotif': '757715671026531',
        'alat musik': '676772489112490',
        'barang antik & koleksi': '393860164117441',
        'cuci gudang': '1834536343472201',
        'lain-lain': '895487550471874',
    };

    // 1. Exact match
    if (fbCategories[name]) return fbCategories[name];

    // 2. Partial match (includes)
    for (const [key, fbId] of Object.entries(fbCategories)) {
        if (name.includes(key) || key.includes(name)) return fbId;
    }

    // 3. Fallback
    return '895487550471874'; // "Lain-lain"
};

// Alias for backward compatibility
const mapCategory = mapCategoryToFbId;

// ============================================
// Extract photo paths from material row (Foto1..Foto20)
// ============================================
function extractPhotoPaths(material) {
    const paths = [];
    for (let i = 1; i <= 20; i++) {
        const p = material[`Foto${i}`];
        if (p && typeof p === 'string' && p.trim().length > 0) {
            // Verify file actually exists
            if (fs.existsSync(p.trim())) {
                paths.push(p.trim());
            }
        }
    }
    return paths;
}

// ============================================
// Extract lat/lng from location data
// Fallback chain: direct fields → saved_locations DB lookup → Jakarta default
// ============================================
function extractCoordinates(material) {
    // Try direct lat/lng fields
    if (material.lat && material.lng) {
        return { lat: parseFloat(material.lat), lng: parseFloat(material.lng) };
    }
    if (material.latitude && material.longitude) {
        return { lat: parseFloat(material.latitude), lng: parseFloat(material.longitude) };
    }

    // Fallback: lookup dari database saved_locations by lokasi text (fbName)
    if (material.lokasi) {
        try {
            const Store = require('electron-store');
            const store = new Store();
            const savedLocations = store.get('saved_locations', []);
            const match = savedLocations.find(
                (loc) => loc.fbName === material.lokasi && loc.latitude && loc.longitude
            );
            if (match) {
                console.log(`[COORDS] Lookup "${material.lokasi}" → ${match.latitude}, ${match.longitude}`);
                return { lat: parseFloat(match.latitude), lng: parseFloat(match.longitude) };
            }
        } catch (e) {
            console.error('[COORDS] Gagal lookup lokasi dari database:', e.message);
        }
    }

    // Fallback terakhir: pusat Jakarta
    console.warn(`[COORDS] ⚠️ Tidak bisa resolve koordinat untuk "${material.lokasi || 'unknown'}". Pakai default Jakarta.`);
    return { lat: -6.2088, lng: 106.8456 };
}

// ============================================
// Build the 'common' data object (single source of truth)
// Used by both publishListing and publishDraftListing
// ============================================
function buildCommonData(material, photoIDs, hideFromFriends = false) {
    const { lat, lng } = extractCoordinates(material);
    const cleanPrice = String(material.harga || '0').replace(/\D/g, '');
    const cleanCategory = String(mapCategoryToFbId(material.kategori));
    const cleanCondition = mapCondition(material.kondisi);
    const cleanTitle = String(material.judul || 'Untitled').substring(0, 100).trim();
    const cleanDescription = String(material.deskripsi || '');
    const tagsArray = material.tags
        ? material.tags.split(',').map((t) => t.trim().substring(0, 20)).filter(Boolean).slice(0, 20)
        : [];

    return {
        attribute_data_json: JSON.stringify({ condition: cleanCondition }),
        category_id: cleanCategory,
        commerce_shipping_carrier: null,
        commerce_shipping_carriers: [],
        comparable_price: 'null',
        cost_per_additional_item: null,
        delivery_types: ['IN_PERSON', 'PUBLIC_MEETUP', 'DOOR_PICKUP', 'DOOR_DROPOFF'],
        description: { text: cleanDescription },
        draft_type: null,
        hidden_from_friends_visibility: hideFromFriends ? 'HIDDEN_FROM_FRIENDS' : 'VISIBLE_TO_EVERYONE',
        is_personalization_required: null,
        is_photo_order_set_by_seller: false,
        is_preview: false,
        item_price: { currency: 'IDR', price: cleanPrice },
        latitude: lat,
        listing_email_id: null,
        longitude: lng,
        min_acceptable_checkout_offer_price: 'null',
        personalization_info: null,
        product_hashtag_names: tagsArray,
        quantity: -1,
        shipping_calculation_logic_version: null,
        shipping_cost_option: 'BUYER_PAID_SHIPPING',
        shipping_cost_range_lower_cost: null,
        shipping_cost_range_upper_cost: null,
        shipping_label_price: '0',
        shipping_label_rate_code: null,
        shipping_label_rate_type: null,
        shipping_offered: false,
        shipping_options_data: [],
        shipping_package_weight: null,
        shipping_price: 'null',
        shipping_service_type: null,
        sku: '',
        source_type: 'composer_listing_type_selector',
        suggested_hashtag_names: [],
        surface: 'composer',
        title: cleanTitle,
        variants: [],
        video_ids: [],
        xpost_target_ids: [],
        comments_disabled: true,
        photo_ids: photoIDs.filter(Boolean).map(String),
    };
}

// ============================================
// Build the 'common' data for EDIT mutation (Tahap 2)
// Exact replica of real FB Edit mutation network capture
// SEPARATE from buildCommonData to avoid leaking Create-only fields
// ============================================
function buildEditCommonData(material, photoIDs, hideFromFriends = false) {
    const { lat, lng } = extractCoordinates(material);
    const cleanPrice = String(material.harga || '0').replace(/\D/g, '');
    const cleanCategory = String(mapCategoryToFbId(material.kategori));
    const cleanCondition = mapCondition(material.kondisi);
    const cleanTitle = String(material.judul || 'Untitled').substring(0, 100).trim();
    const cleanDescription = String(material.deskripsi || '');
    const tagsArray = material.tags
        ? material.tags.split(',').map((t) => t.trim().substring(0, 20)).filter(Boolean).slice(0, 20)
        : [];

    // Field set & order matches real FB Edit mutation network capture EXACTLY
    return {
        attribute_data_json: JSON.stringify({ condition: cleanCondition }),
        category_id: cleanCategory,
        comments_disabled: true,
        commerce_shipping_carrier: null,
        commerce_shipping_carriers: [],
        comparable_price: 'null',
        comparable_price_type: null,
        cost_per_additional_item: null,
        delivery_types: ['DOOR_DROPOFF'],
        description: { text: cleanDescription },
        draft_type: null,
        hidden_from_friends_visibility: hideFromFriends ? 'HIDDEN_FROM_FRIENDS' : 'VISIBLE_TO_EVERYONE',
        is_personalization_required: null,
        is_photo_order_set_by_seller: false,
        is_preview: false,
        item_price: { currency: 'IDR', price: cleanPrice },
        latitude: lat,
        listing_email_id: null,
        longitude: lng,
        min_acceptable_checkout_offer_price: 'null',
        personalization_info: null,
        product_hashtag_names: tagsArray,
        quantity: -1,
        shipping_calculation_logic_version: null,
        shipping_cost_option: 'BUYER_PAID_SHIPPING',
        shipping_cost_range_lower_cost: null,
        shipping_cost_range_upper_cost: null,
        shipping_label_price: '0',
        shipping_label_rate_type: null,
        shipping_offered: false,
        shipping_options_data: [],
        shipping_package_weight: null,
        shipping_price: 'null',
        shipping_service_type: null,
        sku: '',
        source_type: 'browse_tab',
        suggested_hashtag_names: [],
        surface: 'edit_composer',
        title: cleanTitle,
        variants: [],
        video_ids: [],
        // photo_ids INTENTIONALLY OMITTED — upload IDs are converted to FB internal
        // photo object IDs during draft creation. Re-sending upload IDs causes noncoercible_variable_value.
    };
}

// ============================================
// Publish a single listing via GraphQL mutation
// ============================================
/**
 * @param {Object} options
 * @param {import('playwright').Page}           options.page     - Active Playwright page (for UA extraction)
 * @param {import('playwright').BrowserContext} options.context  - Logged-in browser context
 * @param {string} options.fbDtsg                              - CSRF token
 * @param {string} options.uid                                 - User ID (c_user)
 * @param {Object} options.material                            - Material row data
 * @param {string[]} options.photoIDs                          - Array of uploaded photo IDs
 * @returns {Promise<{ success: boolean, url?: string, error?: string }>}
 */
async function publishListing({ page, context, fbDtsg, uid, material, photoIDs, draftType = null, hideFromFriends = false }) {
    try {
        // Use shared builder (single source of truth)
        const commonData = buildCommonData(material, photoIDs, hideFromFriends);

        // ── KUNCI WAJIB TAHAP 1 (CREATE) ──
        commonData.surface = 'composer';
        commonData.source_type = 'marketplace_unknown';

        // SAKLAR DRAFT: set if draft mode, delete if standard
        if (draftType) {
            commonData.draft_type = draftType;
        } else {
            delete commonData.draft_type; // Pastikan bersih jika mode Standar
        }

        const cleanTitle = commonData.title;
        console.log(`[PUBLISH DEBUG PIPELINE] title=${cleanTitle}, photos=${commonData.photo_ids.length}, draftType=${draftType}`);

        // BUNGKUS LUAR — WAJIB ADA AUDIENCE DAN ATTRIBUTION
        const variables = {
            input: {
                client_mutation_id: Math.floor(Math.random() * 1000).toString(),
                actor_id: uid.toString(),
                // PENTING: via_cold_start (bukan 'unexpected') persis seperti data asli FB
                attribution_id_v2: `CometMarketplaceComposerRoot.react,comet.marketplace.composer,via_cold_start,${Date.now()},470633,1606854132932955,,`,
                audience: { marketplace: { marketplace_id: '1995604557329781' } },
                data: {
                    common: commonData,
                },
            },
        };

        // Pastikan tidak ada listing_id yang terbawa dari Edit
        if (variables.input.listing_id) delete variables.input.listing_id;

        // ── HYBRID AUTOMATION: Navigate to Marketplace form to get fresh tokens
        try {
            await page.goto('https://www.facebook.com/marketplace/create/item', {
                waitUntil: 'commit',
                timeout: 45000,
            });
        } catch (navErr) {
            console.log(`[PUBLISH] Warning: Navigasi form timeout (${navErr.message}), mencoba lanjut...`);
        }
        await page.waitForTimeout(3000); // Let React scripts finish loading

        // Extract all security tokens from the fully-loaded page via HTML regex
        const securityTokens = await page.evaluate(() => {
            const html = document.documentElement.innerHTML;

            // Extract lsd
            const lsdMatch = html.match(/"LSD",\[\],\{"token":"([^"]+)"\}/) || html.match(/"lsd":"([^"]+)"/);
            const lsd = lsdMatch ? lsdMatch[1] : '';

            // Extract fb_dtsg
            const dtsgMatch = html.match(/"DTSGInitialData",\[\],\{"token":"([^"]+)"\}/) || html.match(/"fb_dtsg":"([^"]+)"/);
            const fb_dtsg = dtsgMatch ? dtsgMatch[1] : '';

            // Extract jazoest
            const jazoestMatch = html.match(/jazoest=(\d+)/) || html.match(/"jazoest":"([^"]+)"/);
            const jazoest = jazoestMatch ? jazoestMatch[1] : '25413';

            return { fb_dtsg, jazoest, lsd };
        });

        // Use page-extracted fb_dtsg if available, otherwise fall back to parameter
        const finalDtsg = securityTokens.fb_dtsg || fbDtsg;

        console.log(`[PUBLISH] Tokens — dtsg=${finalDtsg ? 'OK' : 'FAIL'}, jazoest=${securityTokens.jazoest}, lsd=${securityTokens.lsd ? 'OK' : 'EMPTY'}`);
        console.log(`[PUBLISH] Sending listing: "${cleanTitle}" with ${photoIDs.filter(Boolean).length} photos`);
        console.log(`[PUBLISH DEBUG] Variables:`, JSON.stringify(variables).substring(0, 500));

        // ── THE TROJAN HORSE: Build formData in Node.js, execute fetch in browser
        console.log(`[PUBLISH] Executing In-Page Fetch (Trojan Horse)...`);

        // Build URLSearchParams entirely in Node.js (context-safe)
        const formData = new URLSearchParams();
        formData.append('av', uid);
        formData.append('__user', uid);
        formData.append('__a', '1');
        formData.append('__req', '6c');
        formData.append('__comet_req', '15');
        formData.append('fb_dtsg', finalDtsg);
        formData.append('jazoest', securityTokens.jazoest);
        if (securityTokens.lsd) formData.append('lsd', securityTokens.lsd);
        formData.append('fb_api_caller_class', 'RelayModern');
        formData.append('fb_api_req_friendly_name', 'useCometMarketplaceListingCreateMutation');
        formData.append('variables', JSON.stringify(variables));
        formData.append('server_timestamps', 'true');
        formData.append('doc_id', '9551550371629242');
        formData.append('fb_api_analytics_tags', '["qpl_active_flow_ids=138820675"]');

        const bodyString = formData.toString();

        // Only pass the serialized string into the browser
        const rawJsonText = await page.evaluate(async (bodyData) => {
            const response = await fetch('https://www.facebook.com/api/graphql/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: bodyData,
            });
            return await response.text();
        }, bodyString);

        // ── Back in Node.js: Parse the response
        if (!rawJsonText || rawJsonText.trim() === '') {
            console.log('[PUBLISH DEBUG] Empty Response Body from In-Page Fetch!');
            return { success: false, error: 'Response body kosong dari server.' };
        }

        let json;
        try {
            const cleanText = rawJsonText.replace('for (;;);', '').trim();
            json = JSON.parse(cleanText);
        } catch (parseErr) {
            console.log('[PUBLISH DEBUG] JSON Parse Error. Raw:', rawJsonText.substring(0, 400));
            return { success: false, error: `Gagal parsing respons: ${parseErr.message}` };
        }

        // Check for GraphQL errors in response
        if (json.errors && json.errors.length > 0) {
            const errMsg = json.errors.map((e) => e.message || e.summary || JSON.stringify(e)).join('; ');
            console.log('[PUBLISH DEBUG] FB GraphQL Error:', JSON.stringify(json.errors).substring(0, 500));
            console.log('[PUBLISH DEBUG] Variables Sent:', JSON.stringify(variables).substring(0, 500));
            return { success: false, error: `FB Error: ${errMsg}` };
        }
        if (json.error) {
            const errMsg = json.errorDescription || json.errorSummary || json.error?.message || JSON.stringify(json.error);
            console.log('[PUBLISH DEBUG] FB Error Object:', JSON.stringify(json).substring(0, 500));
            return { success: false, error: `FB Error: ${errMsg}` };
        }

        // Extract listing URL
        const listingUrl = json?.data?.marketplace_listing_create?.listing?.story?.url
            || json?.data?.marketplace_listing_create?.listing?.marketplace_listing_item?.id
            || null;

        if (listingUrl) {
            console.log(`[PUBLISH] ✓ Listing published: ${listingUrl}`);
            return { success: true, url: String(listingUrl), rawJson: json };
        }

        // Try to get listing ID as fallback
        const listingId = json?.data?.marketplace_listing_create?.listing?.id;
        if (listingId) {
            const url = `https://www.facebook.com/marketplace/item/${listingId}`;
            console.log(`[PUBLISH] ✓ Listing published (ID): ${listingId}`);
            return { success: true, url, rawJson: json };
        }

        console.log('[PUBLISH DEBUG] No URL/ID in response:', JSON.stringify(json).substring(0, 500));
        return { success: false, error: 'Publish berhasil tapi URL listing tidak ditemukan.' };

    } catch (err) {
        console.error(`[PUBLISH] ✗ Error:`, err.message);
        return { success: false, error: err.message || 'Publish gagal (unknown error).' };
    }
}

// ============================================
// Publish a DRAFT listing via GraphQL Edit mutation
// BLIND EDIT: No page navigation needed — fires API from current page context
// Chaining: draft → wait → edit (draft_type: null) = publish
// ============================================
async function publishDraftListing({ page, context, fbDtsg, uid, material, photoIDs, listingId, realPhotoIds, hideFromFriends = false }) {
    try {
        // Use DEDICATED Edit builder
        const commonData = buildEditCommonData(material, photoIDs, hideFromFriends);

        // PHOTO ID HANDLING:
        // If we captured permanent photo IDs from the Draft response, use those.
        // If not, DELETE photo_ids and let FB use the draft's built-in photos.
        if (realPhotoIds && realPhotoIds.length > 0) {
            commonData.photo_ids = realPhotoIds.map(String);
            console.log(`[PUBLISH-DRAFT] Using permanent photo IDs: ${commonData.photo_ids.join(', ')}`);
        } else {
            // Don't include photo_ids at all — FB will use the draft's existing photos
            console.log(`[PUBLISH-DRAFT] No permanent photo IDs, omitting photo_ids from payload`);
        }

        console.log(`[PUBLISH-DRAFT] Blind Edit: Publishing draft ${listingId} for "${commonData.title}"`);

        // Edit mutation: listing_id SEJAJAR dengan actor_id dan data (bukan di dalam data)
        const variables = {
            input: {
                client_mutation_id: Math.floor(Math.random() * 1000).toString(),
                actor_id: uid.toString(),
                listing_id: listingId.toString(),  // SEJAJAR actor_id & data
                data: {
                    common: commonData,
                    // TIDAK ADA listing_id di dalam sini!
                },
            },
        };

        // Extract tokens from the CURRENT page (still on marketplace/create/item after draft creation)
        const pageData = await page.evaluate(() => {
            const html = document.documentElement.innerHTML;
            const lsdMatch = html.match(/"LSD",\[\],\{"token":"([^"]+)"\}/) || html.match(/"lsd":"([^"]+)"/);
            const lsd = lsdMatch ? lsdMatch[1] : '';
            const dtsgMatch = html.match(/"DTSGInitialData",\[\],\{"token":"([^"]+)"\}/) || html.match(/"fb_dtsg":"([^"]+)"/);
            const fb_dtsg = dtsgMatch ? dtsgMatch[1] : '';
            const jazoestMatch = html.match(/jazoest=(\d+)/) || html.match(/"jazoest":"([^"]+)"/);
            const jazoest = jazoestMatch ? jazoestMatch[1] : '25413';
            return { fb_dtsg, jazoest, lsd };
        });

        const finalDtsg = pageData.fb_dtsg || fbDtsg;

        // Build URLSearchParams entirely in Node.js (context-safe)
        const formData = new URLSearchParams();
        formData.append('av', uid);
        formData.append('__user', uid);
        formData.append('__a', '1');
        formData.append('__req', '6d');
        formData.append('__comet_req', '15');
        formData.append('fb_dtsg', finalDtsg);
        formData.append('jazoest', pageData.jazoest);
        if (pageData.lsd) formData.append('lsd', pageData.lsd);
        formData.append('__crn', 'comet.fbweb.CometMarketplaceComposerEditRoute');
        formData.append('fb_api_caller_class', 'RelayModern');
        formData.append('fb_api_req_friendly_name', 'useCometMarketplaceListingEditMutation');
        formData.append('variables', JSON.stringify(variables));
        formData.append('server_timestamps', 'true');
        formData.append('doc_id', '24930649656556141');
        formData.append('fb_api_analytics_tags', '["qpl_active_flow_ids=138816378"]');

        const bodyString = formData.toString();

        console.log(`[PUBLISH-DRAFT DEBUG] Full variables sent:`, JSON.stringify(variables).substring(0, 2000));

        // ── JURUS ILUSI URL (URL SPOOFING) ──
        // pushState fakes the browser URL → manipulates Referer header on fetch
        const fakeUrl = `/marketplace/edit?listing_id=${listingId}&step=audience`;

        const rawJsonText = await page.evaluate(async ({ bodyData, targetUrl }) => {
            // 1. UBAH URL BROWSER TANPA RELOAD — manipulasi header Referer
            window.history.pushState({}, '', targetUrl);

            // 2. TEMBAK API dengan Referer seolah dari halaman Edit
            try {
                const res = await fetch('https://www.facebook.com/api/graphql/', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: bodyData,
                });
                return await res.text();
            } catch (err) {
                return JSON.stringify({ error: err.message });
            }
        }, { bodyData: bodyString, targetUrl: fakeUrl });

        if (!rawJsonText || rawJsonText.trim() === '') {
            return { success: false, error: 'Response body kosong dari edit API.' };
        }

        let json;
        try {
            const cleanText = rawJsonText.replace('for (;;);', '').trim();
            json = JSON.parse(cleanText);
        } catch (parseErr) {
            console.log('[PUBLISH-DRAFT] JSON Parse Error. Raw:', rawJsonText.substring(0, 400));
            return { success: false, error: `Gagal parsing respons edit: ${parseErr.message}` };
        }

        if (json.errors && json.errors.length > 0) {
            const errMsg = json.errors.map((e) => e.message || e.summary || JSON.stringify(e)).join('; ');
            console.log('[PUBLISH-DRAFT DEBUG] Full error:', JSON.stringify(json.errors).substring(0, 1000));
            return { success: false, error: `FB Edit Error: ${errMsg}` };
        }
        if (json.error) {
            const errMsg = json.errorDescription || json.errorSummary || json.error?.message || JSON.stringify(json.error);
            return { success: false, error: `FB Edit Error: ${errMsg}` };
        }

        const editedListingId = json?.data?.marketplace_listing_edit?.listing?.id;
        const editedUrl = json?.data?.marketplace_listing_edit?.listing?.story?.url;

        if (editedUrl) {
            console.log(`[PUBLISH-DRAFT] ✓ Draft published: ${editedUrl}`);
            return { success: true, url: String(editedUrl) };
        }
        if (editedListingId) {
            const url = `https://www.facebook.com/marketplace/item/${editedListingId}`;
            console.log(`[PUBLISH-DRAFT] ✓ Draft published (ID): ${editedListingId}`);
            return { success: true, url };
        }

        console.log('[PUBLISH-DRAFT] No URL/ID in edit response:', JSON.stringify(json).substring(0, 500));
        return { success: false, error: 'Edit berhasil tapi URL listing tidak ditemukan.' };

    } catch (err) {
        console.error(`[PUBLISH-DRAFT] ✗ Error:`, err.message);
        return { success: false, error: err.message || 'Publish draft gagal (unknown error).' };
    }
}

// ============================================
// TAHAP 3: Launch Draft to Public
// Final mutation: CometMarketplacePublishDraftMutation
// doc_id: 9015337771903372 — the "nuclear key"
// ============================================
async function launchDraftToPublic({ page, fbDtsg, uid, listingId }) {
    try {
        console.log(`[LAUNCH-DRAFT] Tahap 3: Meluncurkan draft ${listingId} ke publik...`);

        const variables = {
            input: {
                target_draft_fbid: listingId.toString(),
                actor_id: uid.toString(),
                client_mutation_id: Math.floor(Math.random() * 1000).toString(),
            },
        };

        // Extract tokens from current page
        const pageData = await page.evaluate(() => {
            const html = document.documentElement.innerHTML;
            const lsdMatch = html.match(/"LSD",\[\],\{"token":"([^"]+)"\}/) || html.match(/"lsd":"([^"]+)"/);
            const lsd = lsdMatch ? lsdMatch[1] : '';
            const dtsgMatch = html.match(/"DTSGInitialData",\[\],\{"token":"([^"]+)"\}/) || html.match(/"fb_dtsg":"([^"]+)"/);
            const fb_dtsg = dtsgMatch ? dtsgMatch[1] : '';
            const jazoestMatch = html.match(/jazoest=(\d+)/) || html.match(/"jazoest":"([^"]+)"/);
            const jazoest = jazoestMatch ? jazoestMatch[1] : '25413';
            return { fb_dtsg, jazoest, lsd };
        });

        const finalDtsg = pageData.fb_dtsg || fbDtsg;

        const formData = new URLSearchParams();
        formData.append('av', uid);
        formData.append('__user', uid);
        formData.append('__a', '1');
        formData.append('__req', '6e');
        formData.append('__comet_req', '15');
        formData.append('fb_dtsg', finalDtsg);
        formData.append('jazoest', pageData.jazoest);
        if (pageData.lsd) formData.append('lsd', pageData.lsd);
        formData.append('__crn', 'comet.fbweb.CometMarketplaceComposerEditRoute');
        formData.append('fb_api_caller_class', 'RelayModern');
        formData.append('fb_api_req_friendly_name', 'CometMarketplacePublishDraftMutation');
        formData.append('variables', JSON.stringify(variables));
        formData.append('server_timestamps', 'true');
        formData.append('doc_id', '9015337771903372');  // KUNCI NUKLIR — Publish Draft

        const bodyString = formData.toString();

        console.log(`[LAUNCH-DRAFT DEBUG] Variables:`, JSON.stringify(variables));

        // URL Spoofing — fake Referer to edit page
        const fakeUrl = `/marketplace/edit?listing_id=${listingId}&step=audience`;

        const rawJsonText = await page.evaluate(async ({ bodyData, targetUrl }) => {
            window.history.pushState({}, '', targetUrl);
            try {
                const res = await fetch('https://www.facebook.com/api/graphql/', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: bodyData,
                });
                return await res.text();
            } catch (err) {
                return JSON.stringify({ error: err.message });
            }
        }, { bodyData: bodyString, targetUrl: fakeUrl });

        if (!rawJsonText || rawJsonText.trim() === '') {
            return { success: false, error: 'Response body kosong dari launch API.' };
        }

        let json;
        try {
            const cleanText = rawJsonText.replace('for (;;);', '').trim();
            json = JSON.parse(cleanText);
        } catch (parseErr) {
            console.log('[LAUNCH-DRAFT] JSON Parse Error. Raw:', rawJsonText.substring(0, 400));
            return { success: false, error: `Gagal parsing respons launch: ${parseErr.message}` };
        }

        if (json.errors && json.errors.length > 0) {
            const errMsg = json.errors.map((e) => e.message || e.summary || JSON.stringify(e)).join('; ');
            console.log('[LAUNCH-DRAFT DEBUG] Full error:', JSON.stringify(json.errors).substring(0, 1000));
            return { success: false, error: `FB Launch Error: ${errMsg}` };
        }
        if (json.error) {
            const errMsg = json.errorDescription || json.errorSummary || json.error?.message || JSON.stringify(json.error);
            return { success: false, error: `FB Launch Error: ${errMsg}` };
        }

        // Success — build URL from listing ID
        const finalUrl = `https://www.facebook.com/marketplace/item/${listingId}`;
        console.log(`[LAUNCH-DRAFT] ✓ Draft launched to public: ${finalUrl}`);
        return { success: true, url: finalUrl };

    } catch (err) {
        console.error(`[LAUNCH-DRAFT] ✗ Error:`, err.message);
        return { success: false, error: err.message || 'Launch draft gagal (unknown error).' };
    }
}

module.exports = {
    mapCondition,
    mapCategory,
    mapCategoryToFbId,
    extractPhotoPaths,
    extractCoordinates,
    publishListing,
    publishDraftListing,
    launchDraftToPublic,
};
