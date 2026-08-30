"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const desidub_1 = require("./scrapers/desidub");
async function testSearch() {
    console.log('Search "Attack on Titan":', await (0, desidub_1.searchDesidub)('Attack on Titan'));
    console.log('Search "Shingeki no Kyojin":', await (0, desidub_1.searchDesidub)('Shingeki no Kyojin'));
    console.log('Slug for "Attack on Titan":', await (0, desidub_1.findDesidubSlug)('Attack on Titan'));
    console.log('Slug for "Shingeki no Kyojin":', await (0, desidub_1.findDesidubSlug)('Shingeki no Kyojin'));
}
testSearch();
//# sourceMappingURL=test-search.js.map