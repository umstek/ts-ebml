import { Int64BE } from "int64-buffer";
import type * as EBML from "./EBML";
import { Buffer, convertEBMLDateToJSDate, ebmlBlock, readVint } from "./tools";
import * as tools from "./tools";
import schema = require("matroska/lib/schema");
const { byEbmlID }: { byEbmlID: { [key: number]: EBML.Schema } } = schema;

// https://www.matroska.org/technical/specs/index.html

enum State {
	STATE_TAG = 1,
	STATE_SIZE = 2,
	STATE_CONTENT = 3,
}

export default class EBMLDecoder {
	private _buffer: Buffer;
	private _tag_stack: EBML.EBMLElementDetail[];
	private _state: State;
	/**
	 * position from the top of _buffer
	 */
	private _cursor: number;
	/**
	 * pointer in the whole
	 */
	private _total: number;
	private _schema: { [key: number]: EBML.Schema };
	private _result: EBML.EBMLElementDetail[];

	constructor() {
		this._buffer = new Buffer(0);
		this._tag_stack = [];
		this._state = State.STATE_TAG;
		this._cursor = 0;
		this._total = 0;
		this._schema = byEbmlID;
		this._result = [];
	}

	decode(chunk: ArrayBuffer): EBML.EBMLElementDetail[] {
		this.readChunk(chunk);
		const diff = this._result;
		this._result = [];
		return diff;
	}

	private readChunk(chunk: ArrayBuffer): void {
		// Read again with the unread this._buffer and the new chunk
		this._buffer = tools.concat([this._buffer, new Buffer(chunk)]);
		while (this._cursor < this._buffer.length) {
			// console.log(this._cursor, this._total, this._tag_stack);
			if (this._state === State.STATE_TAG && !this.readTag()) {
				break;
			}
			if (this._state === State.STATE_SIZE && !this.readSize()) {
				break;
			}
			if (this._state === State.STATE_CONTENT && !this.readContent()) {
				break;
			}
		}
	}

	private getSchemaInfo(tagNum: number): EBML.Schema {
		return (
			this._schema[tagNum] || {
				name: "unknown",
				level: -1,
				type: "unknown",
				description: "unknown",
			}
		);
	}

	/**
	 * parsing tag encoded in vint
	 * @return - return false when waiting for more data
	 */
	private readTag(): boolean {
		// tag.length is outside the buffer
		if (this._cursor >= this._buffer.length) {
			return false;
		}

		// read ebml id vint without first byte
		const tag = readVint(this._buffer, this._cursor);

		// tag could not be read
		if (tag == null) {
			return false;
		}

		// >>>>>>>>>
		// tag identifier
		//const tagStr = this._buffer.toString("hex", this._cursor, this._cursor + tag.length);
		//const tagNum = parseInt(tagStr, 16);
		// equivalent to the above
		const buf = this._buffer.slice(this._cursor, this._cursor + tag.length);
		const tagNum = buf.reduce(
			(o, v, i, arr) => o + v * 16 ** (2 * (arr.length - 1 - i)),
			0,
		);

		const schema = this.getSchemaInfo(tagNum);

		const tagObj: EBML.EBMLElementDetail = <any>{
			EBML_ID: tagNum.toString(16),
			schema,
			type: schema.type,
			name: schema.name,
			level: schema.level,
			tagStart: this._total,
			tagEnd: this._total + tag.length,
			sizeStart: this._total + tag.length,
			sizeEnd: null,
			dataStart: null,
			dataEnd: null,
			dataSize: null,
			data: null,
		};
		// | tag: vint | size: vint | data: Buffer(size) |

		this._tag_stack.push(tagObj);
		// <<<<<<<<

		// advance the pointer
		this._cursor += tag.length;
		this._total += tag.length;

		// change the reading state
		this._state = State.STATE_SIZE;

		return true;
	}

	/**
	 * Read the size of the current tag's contents encoded in vint
	 * @return - return false when waiting for more data
	 */
	private readSize(): boolean {
		// tag.length is outside the buffer
		if (this._cursor >= this._buffer.length) {
			return false;
		}

		// read ebml datasize vint without first byte
		const size = readVint(this._buffer, this._cursor);

		// still can't read
		if (size == null) {
			return false;
		}

		// >>>>>>>>>
		// determine the data size of the current tag
		const tagObj = this._tag_stack[this._tag_stack.length - 1];

		tagObj.sizeEnd = tagObj.sizeStart + size.length;

		tagObj.dataStart = tagObj.sizeEnd;

		tagObj.dataSize = size.value;

		if (size.value === -1) {
			// unknown size
			tagObj.dataEnd = -1;
			if (tagObj.type === "m") {
				tagObj.unknownSize = true;
			}
		} else {
			tagObj.dataEnd = tagObj.sizeEnd + size.value;
		}

		// <<<<<<<<

		// advance the pointer
		this._cursor += size.length;
		this._total += size.length;

		this._state = State.STATE_CONTENT;

		return true;
	}

	/**
	 * data reading
	 */
	private readContent(): boolean {
		const tagObj = this._tag_stack[this._tag_stack.length - 1];

		// master element has child elements, so there is no raw data
		if (tagObj.type === "m") {
			// console.log('content should be tags');
			tagObj.isEnd = false;
			this._result.push(tagObj);
			this._state = State.STATE_TAG;
			// Is this Master Element an empty element?
			if (tagObj.dataSize === 0) {
				// Add the end tag immediately
				const elm = Object.assign({}, tagObj, { isEnd: true });
				this._result.push(elm);
				this._tag_stack.pop(); // discard this tag from the stack
			}
			return true;
		}

		// waiting for more data
		if (this._buffer.length < this._cursor + tagObj.dataSize) {
			return false;
		}

		// raw data inside the tag
		const data = this._buffer.slice(
			this._cursor,
			this._cursor + tagObj.dataSize,
		);

		// Discard the read buffer and leave only the buffer being read
		this._buffer = this._buffer.slice(this._cursor + tagObj.dataSize);

		tagObj.data = data;

		// >>>>>>>>>
		switch (tagObj.type) {
			//case "m": break;
			// Master-Element - contains other EBML sub-elements of the next lower level
			case "u":
				tagObj.value = data.readUIntBE(0, data.length);
				break;
			// Unsigned Integer - Big-endian, any size from 1 to 8 octets
			case "i":
				tagObj.value = data.readIntBE(0, data.length);
				break;
			// Signed Integer - Big-endian, any size from 1 to 8 octets
			case "f":
				tagObj.value =
					tagObj.dataSize === 4
						? data.readFloatBE(0)
						: tagObj.dataSize === 8
							? data.readDoubleBE(0)
							: (console.warn(
									`cannot read ${tagObj.dataSize} octets float. failback to 0`,
								),
								0);
				break;
			// Float - Big-endian, defined for 4 and 8 octets (32, 64 bits)
			case "s":
				tagObj.value = data.toString("ascii");
				break; // ascii
			//  Printable ASCII (0x20 to 0x7E), zero-padded when needed
			case "8":
				tagObj.value = data.toString("utf8");
				break;
			//  Unicode string, zero padded when needed (RFC 2279)
			case "b":
				tagObj.value = data;
				break;
			// Binary - not interpreted by the parser
			case "d":
				tagObj.value = convertEBMLDateToJSDate(new Int64BE(data).toNumber());
				break;
			// nano second; Date.UTC(2001,1,1,0,0,0,0) === 980985600000
			// Date - signed 8 octets integer in nanoseconds with 0 indicating
			// the precise beginning of the millennium (at 2001-01-01T00:00:00,000000000 UTC)
		}
		if (tagObj.value === null) {
			throw new Error(`unknown tag type:${tagObj.type}`);
		}
		this._result.push(tagObj);

		// <<<<<<<<

		// advance the pointer
		this._total += tagObj.dataSize;

		// Change to tag waiting mode
		this._state = State.STATE_TAG;
		this._cursor = 0;
		this._tag_stack.pop(); // remove the object from the stack

		while (this._tag_stack.length > 0) {
			const topEle = this._tag_stack[this._tag_stack.length - 1];
			// Since the parent has an indefinite size, the closing tag cannot be expected
			if (topEle.dataEnd < 0) {
				this._tag_stack.pop(); // discard the parent tag
				return true;
			}
			// Whether it has reached the place where the closing tag should come
			if (this._total < topEle.dataEnd) {
				break;
			}
			// The timing to insert the closing tag has come
			if (topEle.type !== "m") {
				throw new Error("parent element is not master element");
			}
			const elm = Object.assign({}, topEle, { isEnd: true });
			this._result.push(elm);
			this._tag_stack.pop();
		}

		return true;
	}
}
