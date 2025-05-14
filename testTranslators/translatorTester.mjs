/*
    ***** BEGIN LICENSE BLOCK *****
    
    Copyright © 2009 Center for History and New Media
                     George Mason University, Fairfax, Virginia, USA
                     http://zotero.org
    
    This file is part of Zotero.
    
    Zotero is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
    
    Zotero is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.
    
    You should have received a copy of the GNU Affero General Public License
    along with Zotero.  If not, see <http://www.gnu.org/licenses/>.
    
    ***** END LICENSE BLOCK *****
*/

export const DEFAULT_DEFER_DELAY = 5; // Default delay for deferred tests (in seconds)

export const TEST_RUN_TIMEOUT = 15000;
export const TEST_TYPES = ['web', 'import', 'export', 'search'];

const { Zotero } = typeof globalThis.Zotero === 'undefined'
	? ChromeUtils.importESModule('chrome://zotero/content/zotero.mjs')
	: globalThis;
const { setTimeout } = typeof globalThis.setTimeout === 'undefined'
	? ChromeUtils.importESModule('resource://gre/modules/Timer.sys.mjs')
	: globalThis;

export class TranslatorTester {

	/**
	 * @param {Zotero.Translator} translator
	 * @param {AbstractWebTranslationEnvironment} [webTranslationEnvironment]
	 * @param {Zotero.Translators} [translatorProvider]
	 * @param {Zotero.CookieSandbox} [cookieSandbox]
	 * @param {(message: any) => void} [debug]
	 */
	constructor(translator, {
		webTranslationEnvironment,
		translatorProvider,
		cookieSandbox,
		debug
	} = {}) {
		this._webTranslationEnvironment = webTranslationEnvironment ?? new HTTPWebTranslationEnvironment();
		this._translator = translator;
		this._translatorProvider = translatorProvider ?? Zotero.Translators;
		if (!cookieSandbox && typeof process === 'object' && process + '' === '[object process]') {
			cookieSandbox = require('request').jar();
		}
		this._cookieSandbox = cookieSandbox;
		this._debug = debug ?? (message => Zotero.debug(message));
	}

	get translator() {
		return this._translator;
	}
	
	get translatorProvider() {
		return this._translatorProvider;
	}
	
	get cookieSandbox() {
		return this._cookieSandbox;
	}
	
	/**
	 * @returns {Promise<Test[]>}
	 */
	async getSavedTests() {
		let code = await this._translatorProvider.getCodeForTranslator(this._translator);
		let testStart = code.indexOf("/** BEGIN TEST CASES **/");
		let testEnd = code.indexOf("/** END TEST CASES **/");
		if (testStart === -1 || testEnd === -1) {
			return [];
		}
		
		let testsJSON = code.substring(testStart + 24, testEnd)
			.replace(/^[\s\r\n]*var testCases = /, '')
			.replace(/;[\s\r\n]*$/, '');
		let tests;
		try {
			tests = JSON.parse(testsJSON);
		}
		catch (e) {
			return [];
		}
		
		if (!Array.isArray(tests)) {
			Zotero.debug('Discarding non-array testCases object');
			return [];
		}
		
		return tests.map(test => new Test(test));
	}

	/**
	 * Run a test in the context of this translator.
	 *
	 * @param {Test} test
	 * @returns {Promise<{
	 *     status: 'success' | 'failure';
	 *     reason?: string;
	 *     updatedTest?: Test;
	 * }>}
	 */
	async run(test) {
		let abortController = new AbortController();
		setTimeout(() => {
			abortController.abort(new Error(`Test timed out after ${TEST_RUN_TIMEOUT / 1000} seconds`));
		}, TEST_RUN_TIMEOUT);

		let result;
		switch (test.type) {
			case 'web':
				result = await this._translateWeb(test, { signal: abortController.signal });
				break;
			case 'import':
			case 'search':
				result = await this._translateImportOrSearch(test, { signal: abortController.signal });
				break;
			case 'export':
				throw new Error('Export tests are not yet supported');
			default:
				throw new Error('Unknown test type: ' + test.type);
		}
		
		let { detectedItemType, items, reason } = result;
		if (!items) {
			// Expected-fail test
			if (!detectedItemType && test.detectedItemType === false) {
				return { status: 'success' };
			}
			// Regular failure
			else {
				return { status: 'failure', reason };
			}
		}
		
		let updatedTest = new Test(test);
		updatedTest.detectedItemType = detectedItemType;
		updatedTest.items = items;

		if (updatedTest.detectedItemType !== test.detectedItemType) {
			return {
				status: 'failure',
				reason: 'Detection returned wrong item type',
				updatedTest,
			};
		}

		if (test.items === 'multiple' || items === 'multiple') {
			if (test.items !== items) {
				let expected = test.items === 'multiple' ? 'multiple' : 'single item';
				let got = items === 'multiple' ? 'multiple' : 'single item';
				return {
					status: 'failure',
					reason: `Expected ${expected}, got ${got}`,
					updatedTest,
				};
			}
		}
		
		if (!test.equals(updatedTest)) {
			return {
				status: 'failure',
				reason: 'Data mismatch',
				updatedTest,
			};
		}
		
		return {
			status: 'success',
			updatedTest,
		};
	}
	
	async _translateWeb(test, { signal }) {
		let numSelectItemsCalls = 0;
		let selectHandler = async (_, items, callback) => {
			numSelectItemsCalls++;
			
			if (!Object.entries(items).length) {
				throw new Error('Empty selectItems() object should be prevented by Zotero.Translate');
			}
			// Translate up to three results
			items = Object.fromEntries(Object.entries(items).slice(0, 3));
			
			// It's hard to deal with a callback across messaging-only
			// boundaries. This handler should technically (unfortunately)
			// be passed a callback, but we'll return a promise too.
			if (callback && typeof callback === 'function') {
				// Invoke callback asynchronously, as a browser would
				setTimeout(() => callback(items));
			}
			return items;
		};
		
		let handlers = {
			debug: (_, message) => this._debug(message),
			error: (_, error) => this._debug(error),
			select: selectHandler,
		};
		
		let page = await this._webTranslationEnvironment.fetchPage(test.url, { tester: this });
		let result;
		try {
			let pageShouldBeLoaded = await this._webTranslationEnvironment.waitForLoad(page, { tester: this });
			if (!pageShouldBeLoaded && test.defer) {
				let delay = typeof test.defer === 'number'
					? test.defer
					: DEFAULT_DEFER_DELAY;
				this._debug(`Waiting ${delay} ${Zotero.Utilities.pluralize(delay, 'second')} for page content to settle`);
				await Zotero.Promise.delay(delay * 1000);
			}

			result = await this._webTranslationEnvironment.runTranslation(page, {
				tester: this,
				handlers,
				signal,
			});
		}
		finally {
			this._webTranslationEnvironment.destroy(page);
		}
		
		let { detectedItemType, items, reason } = result;
		
		if (!items && reason) {
			return { detectedItemType, items, reason };
		}
		if (numSelectItemsCalls > 1) {
			return { detectedItemType, items: null, reason: 'Translator called selectItems multiple times' };
		}
		if (!items?.length) {
			return { detectedItemType, items: null, reason: 'Translator did not return any items' };
		}
		
		if (numSelectItemsCalls) {
			return { detectedItemType, items: 'multiple' };
		}
		else {
			return { detectedItemType, items };
		}
	}
	
	async _translateImportOrSearch(test, { signal }) {
		let { type } = test;
		let translate = Zotero.Translate.newInstance(type);
		if (type === 'import') {
			translate.setString(test.input);
		}
		else {
			translate.setSearch(test.input);
			translate.setCookieSandbox(this._cookieSandbox);
		}
		translate.setTranslatorProvider(this._translatorProvider);
		translate.setTranslator(this._translator);
		translate.setHandler('debug', (_, message) => this._debug(message));
		translate.setHandler('error', (_, error) => this._debug(error));

		signal.addEventListener('abort', () => {
			translate.complete(false, new Error(signal.reason));
		});

		// "internal hack to call detect on this translator"
		translate._potentialTranslators = [this._translator];
		translate._foundTranslators = [];
		translate._currentState = 'detect';
		
		let detectedItemType = await translate._detect();
		if (!detectedItemType) {
			return { items: null, reason: 'Detection failed' };
		}

		return { detectedItemType, items: await translate.translate({ libraryID: false }) };
	}
}

/**
 * @abstract
 */
export class AbstractWebTranslationEnvironment {

	/**
	 * @abstract
	 * @param {string} url
	 * @param {TranslatorTester} tester
	 * @returns {Promise<unknown>}
	 */
	async fetchPage(url, { tester }) {
		throw new Error('Unimplemented');
	}

	/**
	 * @abstract
	 * @param {unknown} page
	 * @param {TranslatorTester} tester
	 * @returns {Promise<boolean>} Return false if still not sure that the page is fully loaded
	 */
	async waitForLoad(page, { tester }) {
		throw new Error('Unimplemented');
	}

	/**
	 * @abstract
	 * @param {unknown} page The object returned from fetchPage() earlier
	 * @param {TranslatorTester} tester
	 * @param {Record<string, Function>} handlers
	 * @param {AbortSignal} signal
	 * @returns {Promise<{
	 *     detectedItemType?: string;
	 *     items?: Zotero.Item[];
	 *     reason?: string;
	 * }>}
	 */
	async runTranslation(page, { tester, handlers, signal }) {
		throw new Error('Unimplemented');
	}

	/**
	 * @param {unknown} page The object returned from fetchPage() earlier
	 * @returns {Promise<void> | void}
	 */
	destroy(page) {
		// Default no-op implementation
	}
}

export class HTTPWebTranslationEnvironment extends AbstractWebTranslationEnvironment {

	/**
	 * @param {string} url
	 * @param {TranslatorTester} tester
	 * @returns {Promise<Document>}
	 */
	async fetchPage(url, { tester }) {
		return new Promise(resolve => Zotero.HTTP.processDocuments(
			url,
			doc => resolve(doc),
			{ cookieSandbox: tester.cookieSandbox }
		));
	}

	/**
	 * @param {Document} doc
	 * @param {TranslatorTester} tester
	 * @returns {Promise<true>} Always true, no more waiting necessary - our document is static
	 */
	async waitForLoad(doc, { tester }) {
		return true;
	}

	/**
	 * @param {Document} doc
	 * @param {TranslatorTester} tester
	 * @param {Record<string, Function>} handlers
	 * @param {AbortSignal} signal
	 * @returns {Promise<{
	 *     detectedItemType?: string;
	 *     items?: Zotero.Item[];
	 *     reason?: string;
	 * }>}
	 */
	async runTranslation(doc, { tester, handlers, signal }) {
		let translate = new Zotero.Translate.Web();
		translate.setDocument(doc);
		translate.setTranslatorProvider(tester.translatorProvider);
		translate.setCookieSandbox(tester.cookieSandbox);
		translate.setTranslator(tester.translator);
		for (let [type, fn] of Object.entries(handlers)) {
			translate.setHandler(type, fn);
		}

		signal.addEventListener('abort', () => {
			translate.complete(false, new Error(signal.reason));
		});

		let detectedTranslators = await translate.getTranslators(
			/* getAllTranslators */ false,
			/* checkSetTranslator */ true
		);
		if (!detectedTranslators.length) {
			return { items: null, reason: 'Detection failed' };
		}

		let detectedItemType = detectedTranslators[0].itemType;
		let items = await translate.translate();
		return { detectedItemType, items };
	}
}

export class Test {
	constructor(testInit) {
		if (testInit instanceof this.constructor) {
			testInit = testInit.toJSON();
		}
		this.type = testInit.type;
		this.defer = testInit.defer ?? false;
		this.input = testInit.input ?? testInit.url;
		this.items = testInit.items;
		this.detectedItemType = testInit.detectedItemType ?? this._inferItemType();
	}
	
	get type() {
		return this._type;
	}
	
	set type(type) {
		if (!TEST_TYPES.includes(type)) {
			throw new Error(`Invalid test type: ${type}`);
		}
		this._type = type;
	}
	
	get defer() {
		return this._defer;
	}
	
	set defer(defer) {
		if (defer) {
			if (defer !== true && typeof defer !== 'number') {
				throw new Error(`Invalid defer: ${defer}`);
			}
		}
		else {
			defer = undefined;
		}
		this._defer = defer;
	}
	
	get input() {
		return this._input;
	}
	
	set input(input) {
		let expectedType = this._type === 'web' || this._type === 'import'
			? 'string'
			: 'object';
		if (typeof input !== expectedType) {
			throw new Error(`${this._type} test input must be a string`);
		}
		this._input = input;
	}
	
	get url() {
		if (this._type !== 'web') {
			throw new Error(`${this._type} test has no url`);
		}
		return this._input;
	}
	
	set url(url) {
		if (this._type !== 'web') {
			throw new Error(`${this._type} test has no url`);
		}
		this._input = url;
	}
	
	get detectedItemType() {
		return this._detectedItemType;
	}
	
	set detectedItemType(detectedItemType) {
		if (detectedItemType !== undefined
				&& typeof detectedItemType !== 'string' && typeof detectedItemType !== 'boolean') {
			throw new Error('detectedItemType must be a string or boolean');
		}
		this._detectedItemType = detectedItemType;
	}
	
	get items() {
		return this._items;
	}
	
	set items(items) {
		if (!Array.isArray(items) && items !== 'multiple') {
			throw new Error('items must be an array or "multiple"');
		}
		this._items = Array.isArray(items)
			? items.map(item => sanitizeItem(item))
			: items;
	}

	/**
	 * @param {Test} test
	 */
	equals(test) {
		return deepEqual(this.toJSON(), test.toJSON());
	}

	/**
	 * @param {Test} test
	 * @returns {string}
	 */
	diffWith(test) {
		// JSON.parse(JSON.stringify()) runs toJSON() and removes
		// undefined fields
		let cleaned1 = JSON.parse(JSON.stringify(this));
		let cleaned2 = JSON.parse(JSON.stringify(test));
		return diff(cleaned1, cleaned2);
	}
	
	toJSON() {
		return {
			type: this._type,
			defer: this._defer,
			[this._type === 'web' ? 'url' : 'input']: this._input,
			detectedItemType:
				this._detectedItemType && this._detectedItemType === this._inferItemType()
					? undefined
					: this._detectedItemType,
			items: this._items,
		};
	}
	
	_inferItemType() {
		if (this._type !== 'web') {
			return !!this._items.length;
		}
		else if (this._items === 'multiple') {
			return 'multiple';
		}
		else if (this._items.length) {
			return this._items[0].itemType;
		}
		else {
			return false;
		}
	}
}

/**
 * Removes document objects, which contain cyclic references, and other fields to be ignored from items
 * @param {any} Item, in the format returned by Zotero.Item.serialize()
 */
function sanitizeItem(item) {
	// remove cyclic references
	if (item.attachments && item.attachments.length) {
		// don't actually test URI equality
		for (let attachment of item.attachments) {
			if (attachment.document) {
				delete attachment.document;
				// Mirror connector/server itemDone() behavior from translate.js
				attachment.mimeType = 'text/html';
			}
			
			if (attachment.url) {
				delete attachment.url;
			}
			
			if (attachment.complete) {
				delete attachment.complete;
			}
		}
	}
	
	// try to convert to JSON and back to get rid of undesirable undeletable elements; this may fail
	try {
		item = JSON.parse(JSON.stringify(item));
	}
	catch {}
	
	// Remove fields that don't exist or aren't valid for this item type, and normalize base fields
	// to fields specific to this item
	let typeID = Zotero.ItemTypes.getID(item.itemType);
	const skipFields = new Set([
		'note',
		'notes',
		'itemID',
		'attachments',
		'tags',
		'seeAlso',
		'itemType',
		'creators',
		'complete',
	]);
	for (let field in item) {
		if (skipFields.has(field)) {
			continue;
		}
		
		let fieldID = Zotero.ItemFields.getID(field);
		if (!fieldID || !item[field]) {
			delete item[field];
			continue;
		}
		
		// If this item type has a type-specific subfield for this field,
		// move the value to that field
		let subfieldID = Zotero.ItemFields.getFieldIDFromTypeAndBase(typeID, fieldID);
		if (subfieldID && subfieldID !== fieldID) {
			item[Zotero.ItemFields.getName(subfieldID)] = item[field];
			delete item[field];
			continue;
		}
		
		if (!Zotero.ItemFields.isValidForType(fieldID, typeID)) {
			delete item[field];
		}
	}
	
	// remove fields to be ignored
	delete item.accessDate;
	
	// Sort tags
	if (item.tags && Array.isArray(item.tags)) {
		// Normalize tags -- necessary until tests are updated for 5.0
		item.tags = Zotero.Translate.Base.prototype._cleanTags(item.tags);
		item.tags.sort((a, b) => {
			if (a.tag < b.tag) return -1;
			if (b.tag < a.tag) return 1;
			return 0;
		});
	}
	
	return item;
}

/**
 * Generate a diff of items
 */
export function diff(a, b) {
	function show(a, action, prefix, indent) {
		if ((typeof a === 'object' && a !== null) || typeof a === 'function') {
			var isArray = Object.prototype.toString.apply(a) === '[object Array]',
				startBrace = (isArray ? '[' : '{'),
				endBrace = (isArray ? ']' : '}'),
				changes = '',
				haveKeys = false;
			
			for (var key in a) {
				if (!a.hasOwnProperty(key)) continue;
				
				haveKeys = true;
				changes += show(a[key], action,
					isArray ? '' : JSON.stringify(key) + ': ', indent + '  ');
			}
			
			if (haveKeys) {
				return action + ' ' + indent + prefix + startBrace + '\n'
					+ changes + action + ' ' + indent + endBrace + '\n';
			}
			return action + ' ' + indent + prefix + startBrace + endBrace + '\n';
		}
		
		return action + ' ' + indent + prefix + JSON.stringify(a) + '\n';
	}
	
	function compare(a, b, prefix, indent) {
		if (!prefix) prefix = '';
		if (!indent) indent = '';
		
		if (((typeof a === 'object' && a !== null) || typeof a === 'function')
				&& ((typeof b === 'object' && b !== null) || typeof b === 'function')) {
			let aIsArray = Array.isArray(a),
				bIsArray = Array.isArray(b);
			if (aIsArray === bIsArray) {
				let startBrace = (aIsArray ? '[' : '{'),
					endBrace = (aIsArray ? ']' : '}'),
					changes = '',
					haveKeys = false;
				
				for (let key in a) {
					if (!a.hasOwnProperty(key)) continue;
					
					haveKeys = true;
					let keyPrefix = aIsArray ? '' : JSON.stringify(key) + ': ';
					if (b.hasOwnProperty(key)) {
						changes += compare(a[key], b[key], keyPrefix, indent + '  ');
					}
					else {
						changes += show(a[key], '-', keyPrefix, indent + '  ');
					}
				}
				for (var key in b) {
					if (!b.hasOwnProperty(key)) continue;
					
					haveKeys = true;
					if (!a.hasOwnProperty(key)) {
						var keyPrefix = aIsArray ? '' : JSON.stringify(key) + ': ';
						changes += show(b[key], '+', keyPrefix, indent + '  ');
					}
				}
				
				if (haveKeys) {
					return '  ' + indent + prefix + startBrace + '\n'
						+ changes + '  ' + indent + (aIsArray ? ']' : '}') + '\n';
				}
				return '  ' + indent + prefix + startBrace + endBrace + '\n';
			}
		}
		
		if (a === b) {
			return show(a, ' ', prefix, indent);
		}
		return show(a, '-', prefix, indent) + show(b, '+', prefix, indent);
	}
	
	// Remove last newline
	return compare(a, b).trimEnd();
}

function deepEqual(a, b) {
	if (
		(typeof a === 'object' && a !== null || typeof a === 'function')
		&& (typeof a === 'object' && b !== null || typeof b === 'function')
	) {
		if (Array.isArray(a) !== Array.isArray(b)) {
			return false;
		}
		for (let key in a) {
			if (!a.hasOwnProperty(key)) continue;
			if (!b.hasOwnProperty(key)) return false;
			if (!deepEqual(a[key], b[key])) return false;
		}
		for (let key in b) {
			if (!b.hasOwnProperty(key)) continue;
			if (!a.hasOwnProperty(key)) return false;
		}
		return true;
	}
	else if (typeof a === 'string' && typeof b === 'string') {
		// Ignore whitespace mismatches on strings
		// (TODO: Do we really want that?)
		return a === b || Zotero.Utilities.trimInternal(a) === Zotero.Utilities.trimInternal(b);
	}
	return a === b;
}
