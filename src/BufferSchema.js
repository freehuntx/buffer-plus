'use strict';
/* eslint-disable quotes */
/* eslint-disable no-new-func */

const BufferPlus = require('./BufferPlus.js');
const Int64BE = require('int64-buffer').Int64BE;
const Int64LE = require('int64-buffer').Int64LE;
const UInt64BE = require('int64-buffer').Uint64BE;
const UInt64LE = require('int64-buffer').Uint64LE;
const VarInt = require('./VarInt.js');

// eslint-disable-next-line no-unused-vars
const debug = require('util').debuglog('bp');

const MSB_BYTES = ~(0x7F);


class BufferSchema
{
    constructor(name)
    {
        this.name = name;
        this._encoding = 'utf8';

        this._decodeCtx = [];
        this._decodeInnerFuncs = {};

        this._encodeCtx = [];
        this._encodeInnerFuncs = {};

        this._byteLengthCtx = [];
        this._byteLengthInnerFuncs = {};

        this._encodeFunc = function(buffer, json, helper) {
            throw new Error('Not implemented.');
        };

        this._decodeFunc = function(buffer, helper) {
            throw new Error('Not implemented.');
        };

        this._byteLengthFunc = function(json, helper) {
            throw new Error('Not implemented.');
        };

    }

    encode(buffer, data)
    {
        this._encodeFunc.call(null, buffer, data, helper);
    }

    decode(buffer)
    {
        return this._decodeFunc.call(null, buffer, helper);
    }

    byteLength(data)
    {
        return this._byteLengthFunc.call(null, data, helper);
    }

    setEncoding(encoding)
    {
        if (!BufferPlus.isEncoding(encoding))
            throw new TypeError('encoding must be a valid string encoding');
        this._encoding = encoding;
    }

    addField(key, dataType)
    {
        let funcStr;
        if (dataType instanceof BufferSchema)
        {
            const schema = dataType;
            const funcName = `Schema${schema.name}`;

            this._decodeInnerFuncs[schema.name] = schema.getDecodeNameFuncStr(`_read${funcName}`);
            this._encodeInnerFuncs[schema.name] = schema.getEncodeNameFuncStr(`_write${funcName}`);
            this._byteLengthInnerFuncs[schema.name] = schema.getByteLengthNameFuncStr(`_byteLength${funcName}`);
            funcStr = {
                read: `data.${key} = _read${funcName}(buffer, helper);`,
                write: `_write${funcName}(buffer, json.${key}, helper);`,
                size: `byteCount += _byteLength${funcName}(json.${key}, helper);`
            };
        }
        else
        {
            funcStr = getDataTypeFunctionString(dataType, key);
        }

        this._encodeCtx.push(funcStr.write);
        this._decodeCtx.push(funcStr.read);
        this._byteLengthCtx.push(funcStr.size);

        return this;
    }

    addArrayField(key, dataType)
    {
        key = key.trim();
        const arrayLenVal = `${key}_arr_len`;
        const arrayIter = `${key}_iter`;
        const itemStr = `${key}[${arrayIter}]`;

        const arrayLenVal2 = `${key}_arr_len2`;
        const arrayIter2 = `${key}_iter2`;
        const itemStr2 = `${key}[${arrayIter2}]`;

        let funcStr, sizeFuncStr;

        if (dataType instanceof BufferSchema)
        {
            const schema = dataType;
            const funcName = `Schema${schema.name}`;
            this._decodeInnerFuncs[schema.name] = schema.getDecodeNameFuncStr(`_read${funcName}`);
            this._encodeInnerFuncs[schema.name] = schema.getEncodeNameFuncStr(`_write${funcName}`);
            this._byteLengthInnerFuncs[schema.name] = schema.getByteLengthNameFuncStr(`_byteLength${funcName}`);

            funcStr = {
                read: `data.${itemStr} = _read${funcName}(buffer, helper);`,
                write: `_write${funcName}(buffer, json.${itemStr}, helper)`,
            };
            sizeFuncStr = `byteCount += _byteLength${funcName}(json.${itemStr2}, helper);`;
        }
        else
        {
            funcStr = getDataTypeFunctionString(dataType, itemStr);
            sizeFuncStr = getBuiltinSizeString(dataType, 'json.' + itemStr2);
        }


        this._decodeCtx.push(`
            let ${arrayLenVal} = helper.readVarUInt(buffer);
            data.${key} = [];
            for (let ${arrayIter} = 0; ${arrayIter} < ${arrayLenVal}; ${arrayIter}++) {
                ${funcStr.read}
            }
        `);

        this._encodeCtx.push(`
            let ${arrayLenVal} = json.${key}.length;
            helper.writeVarUInt(buffer, ${arrayLenVal});
            for (let ${arrayIter} = 0; ${arrayIter} < ${arrayLenVal}; ${arrayIter}++) {
                ${funcStr.write}
            }
        `);

        this._byteLengthCtx.push(`
            let ${arrayLenVal2} = json.${key}.length;
            byteCount += helper.byteLengthVarUInt(${arrayLenVal2});
            for (let ${arrayIter2} = 0; ${arrayIter2} < ${arrayLenVal2}; ${arrayIter2}++) {
                ${sizeFuncStr}
            }
        `);

        return this;
    }

    buildOnce()
    {
        if (this._buildOnce !== true)
        {
            this.build();
            this._buildOnce = true;
        }
    }

    build()
    {
        const decodeFuncStr = this._buildDecodeFuncStr();
        const encodeFuncStr = this._buildEncodeFuncStr();
        const byteLengthFuncStr = this._buildByteLengthFuncStr();

        this._decodeFunc = new Function('rBuffer', 'helper', decodeFuncStr);
        this._encodeFunc = new Function('wBuffer', 'json', 'helper', encodeFuncStr);
        this._byteLengthFunc = new Function('json', 'helper', byteLengthFuncStr);
        debug('_decodeFunc:\n', this._decodeFunc.toString());
        debug('_encodeFunc:\n', this._encodeFunc.toString());
        debug('_byteLengthFunc:\n', this._byteLengthFunc.toString());
    }

    getDecodeNameFuncStr(funcName)
    {
        const decodeFuncStr = this._buildDecodeFuncStr(true);
        return `const ${funcName} = function (buffer, helper) {${decodeFuncStr}};`;
    }

    getEncodeNameFuncStr(funcName)
    {
        const encodeFuncStr = this._buildEncodeFuncStr(true);
        return `const ${funcName} = function (buffer, json, helper) {${encodeFuncStr}};`;
    }

    getByteLengthNameFuncStr(funcName)
    {
        const byteLengthFuncStr = this._buildByteLengthFuncStr(true);
        return `const ${funcName} = function (json, helper) {${byteLengthFuncStr}};`;
    }



    // proxy method
    _getDataTypeByteLength(value, dataType, encoding)
    {
        return BufferPlus._getDataTypeByteLength(value, dataType, encoding);
    }

    _buildDecodeFuncStr(inner)
    {
        const rootPrefix = inner ? [] : [
            'const buffer = rBuffer._buf;',
            'helper.offset = 0;',
        ];
        const decodePrefixs = [
            `const strEnc = '${this._encoding}';`,
            'const data = {};',
        ];
        const decodeSuffixs = [
            inner ? '' : 'rBuffer._forceMoveTo(helper.offset);',
            'return data;'
        ];

        for (let name in this._decodeInnerFuncs)
            decodePrefixs.unshift(this._decodeInnerFuncs[name]);

        return rootPrefix.concat(
            decodePrefixs,
            this._decodeCtx,
            decodeSuffixs
        ).join('\n');
    }

    _buildEncodeFuncStr(inner)
    {
        const encodePrefixs = [
            inner ? [] : `var strEnc = '${this._encoding}';`,
        ];
        const encodeSuffixs = [
            inner ? '' : 'wBuffer._forceOffset(helper.offset);',
        ];

        for (let name in this._encodeInnerFuncs)
            encodePrefixs.unshift(this._encodeInnerFuncs[name]);

        for (let name in this._byteLengthInnerFuncs)
            encodePrefixs.unshift(this._byteLengthInnerFuncs[name]);

        return encodePrefixs.concat(
            inner ? [] : 'helper.offset = 0;',
            inner ? [] : 'let byteCount = 0;',
            inner ? [] : this._byteLengthCtx,
            inner ? [] : `wBuffer._ensureWriteSize(byteCount);`,
            inner ? [] : `const buffer = wBuffer._buf;`,
            this._encodeCtx,
            encodeSuffixs
        ).join('\n');
    }

    _buildByteLengthFuncStr(inner)
    {

        const prefixs = [
            // 'if (!json instanceof Object) throw new TypeError("Invalid json data for encoder");',
            `const strEnc = '${this._encoding}';`,
            'let byteCount = 0;'
        ];
        const suffixs = [
            'return byteCount;'
        ];

        for (let name in this._byteLengthInnerFuncs)
            prefixs.unshift(this._byteLengthInnerFuncs[name]);

        return prefixs.concat(this._byteLengthCtx, suffixs).join('\n');
    }
} // class BufferSchema



// helper read/write Int64
function readInt64BE(buffer)
{
    const value = new Int64BE(buffer.slice(helper.offset, helper.offset + 8));
    helper.offset += 8;
    return value.toNumber();
}

function readInt64LE(buffer)
{
    const value = new Int64LE(buffer.slice(helper.offset, helper.offset + 8));
    helper.offset += 8;
    return value.toNumber();
}

function readUInt64BE(buffer)
{
    const value = new UInt64BE(buffer.slice(helper.offset, helper.offset + 8));
    helper.offset += 8;
    return value.toNumber();
}

function readUInt64LE(buffer)
{
    const value = new UInt64LE(buffer.slice(helper.offset, helper.offset + 8));
    helper.offset += 8;
    return value.toNumber();
}

function writeInt64BE(buffer, value)
{
    const int64 = new Int64BE(value);
    int64.toBuffer().copy(buffer, helper.offset, 0, 8);
    helper.offset += 8;
}

function writeInt64LE(buffer, value)
{
    const int64 = new Int64LE(value);
    int64.toBuffer().copy(buffer, helper.offset, 0, 8);
    helper.offset += 8;
}

function writeUInt64BE(buffer, value)
{
    const int64 = new UInt64BE(value);
    int64.toBuffer().copy(buffer, helper.offset, 0, 8);
    helper.offset += 8;
}

function writeUInt64LE(buffer, value)
{
    const int64 = new UInt64LE(value);
    int64.toBuffer().copy(buffer, helper.offset, 0, 8);
    helper.offset += 8;
}

// helper read/write var uint
function readVarUInt(buffer)
{
    let val = 0;
    let shift = 0;
    let byte;
    do
    {
        byte = buffer[helper.offset++];
        val += (shift < 28)
            ? (byte & 0x7F) << shift
            : (byte & 0x7F) * Math.pow(2, shift);
        shift += 7;
    }
    while (byte & 0x80);

    return val;
}

function writeVarUInt(buffer, value)
{
    while (value >= 2147483648) // value >= 2^31
    {
        buffer[helper.offset++] = (value & 0xFF) | 0x80;
        value /= 128;
    }

    while (value > 127)
    {
        buffer[helper.offset++] = (value & 0xFF) | 0x80;
        value >>>= 7;
    }
    buffer[helper.offset++] = value | 0;
}

// helper read/write var int
function readVarInt(buffer)
{
    const val = readVarUInt(buffer);
    return (val & 1) ? (val + 1) / -2 : val / 2;
}

function writeVarInt(buffer, value)
{
    const val = value >= 0 ? value * 2 : (value * -2) - 1;
    writeVarUInt(buffer, val);
}

// helper read/write string
function readString(buffer, strEnc)
{
    const len = readVarUInt(buffer);
    const str = buffer.toString(strEnc, helper.offset, helper.offset + len);
    helper.offset += len;
    return str;
}

function writeString(buffer, value, encoding)
{
    const len = Buffer.byteLength(value);
    writeVarUInt(buffer, len);
    buffer.write(value, helper.offset, len, encoding);
    helper.offset += len;
}

// helper read/write Buffer
function readBuffer(buffer)
{
    const len = readVarUInt(buffer);
    const buf = buffer.slice(helper.offset, helper.offset + len)
    helper.offset += len;
    return buf;
}

function writeBuffer(buffer, value)
{
    const len = value.len;
    writeVarUInt(buffer, len);
    value.copy(buffer, helper.offset)
    helper.offset += len;
}

const helper = {
    offset: 0,
    getDataTypeByteLength: BufferPlus._getDataTypeByteLength,

    readInt64BE: readInt64BE,
    readInt64LE: readInt64LE,
    readUInt64BE: readUInt64BE,
    readUInt64LE: readUInt64LE,
    writeInt64BE: writeInt64BE,
    writeInt64LE: writeInt64LE,
    writeUInt64BE: writeUInt64BE,
    writeUInt64LE: writeUInt64LE,

    readVarInt: readVarInt,
    writeVarInt: writeVarInt,

    readVarUInt: readVarUInt,
    writeVarUInt: writeVarUInt,

    readString: readString,
    writeString: writeString,

    readBuffer: readBuffer,
    writeBuffer: writeBuffer,

    byteLengthString: function(value, encoding)
    {
        const len = Buffer.byteLength(value);
        return VarInt.byteLengthUInt(len) + len;
    },

    byteLengthBuffer: function(value)
    {
        const len = value.length;
        return VarInt.byteLengthUInt(len) + len;
    },

    byteLengthVarInt: function(value)
    {
        return VarInt.byteLengthInt(value);
    },

    byteLengthVarUInt: function(value)
    {
        return VarInt.byteLengthUInt(value);
    },

};


const READ_BUILTIN_TYPES = {
    'boolean': 'buffer.readInt8(helper.offset, true); helper.offset += 1;',
    'int8': 'buffer.readInt8(helper.offset, true); helper.offset += 1;',
    'int16be': 'buffer.readInt16BE(helper.offset, true); helper.offset += 2;',
    'int16le': 'buffer.readInt16LE(helper.offset, true); helper.offset += 2;',
    'int32be': 'buffer.readInt32BE(helper.offset, true); helper.offset += 4;',
    'int32le': 'buffer.readInt32LE(helper.offset, true); helper.offset += 4;',
    'int64be': 'helper.readInt64BE(buffer);',
    'int64le': 'helper.readInt64LE(buffer);',

    'uint8': 'buffer.readUInt8(helper.offset, true); helper.offset += 1;',
    'uint16be': 'buffer.readUInt16BE(helper.offset, true); helper.offset += 2;',
    'uint16le': 'buffer.readUInt16LE(helper.offset, true); helper.offset += 2;',
    'uint32be': 'buffer.readUInt32BE(helper.offset, true); helper.offset += 4;',
    'uint32le': 'buffer.readUInt32LE(helper.offset, true); helper.offset += 4;',
    'uint64be': 'helper.readUInt64BE(buffer);',
    'uint64le': 'helper.readUInt64LE(buffer);',

    'floatbe': 'buffer.readFloatBE(helper.offset, true); helper.offset += 4;',
    'floatle': 'buffer.readFloatLE(helper.offset, true); helper.offset += 4;',

    'doublebe': 'buffer.readDoubleBE(helper.offset, true); helper.offset += 8;',
    'doublele': 'buffer.readDoubleLE(helper.offset, true); helper.offset += 8;',

    'varint': 'helper.readVarInt(buffer);',
    'varuint': 'helper.readVarUInt(buffer);',


    'string': 'helper.readString(buffer, strEnc);',
    'buffer': 'helper.readBuffer(buffer);',
};

function _genWriteStr(funcName, valueStr)
{
    return `helper.offset =buffer.write${funcName}(${valueStr}, helper.offset, true);`;
}

function getBuiltinWriteString(dataType, valueStr)
{
    switch (dataType)
    {
        case 'boolean': return _genWriteStr('UInt8', valueStr + ' ? 1 : 0');
        case 'int8': return _genWriteStr('Int8', valueStr);
        case 'int16be': return _genWriteStr('Int16BE', valueStr);
        case 'int16le': return _genWriteStr('Int16LE', valueStr);
        case 'int32be': return _genWriteStr('Int32BE', valueStr);
        case 'int32le': return _genWriteStr('Int32LE', valueStr);
        case 'int64be': return `helper.writeInt64BE();`;
        case 'int64le': return `helper.writeInt64LE();`;

        case 'uint8': return _genWriteStr('UInt8', valueStr);
        case 'uint16be': return _genWriteStr('UInt16BE', valueStr);
        case 'uint16le': return _genWriteStr('UInt16LE', valueStr);
        case 'uint32be': return _genWriteStr('UInt32BE', valueStr);
        case 'uint32le': return _genWriteStr('UInt32LE', valueStr);
        case 'uint64be': return `helper.writeUInt64BE();`;
        case 'uint64le': return `helper.writeUInt64LE();`;

        case 'floatbe': return _genWriteStr('FloatBE', valueStr);
        case 'floatle': return _genWriteStr('FloatLE', valueStr);
        case 'doublebe': return _genWriteStr('DoubleBE', valueStr);
        case 'doublele': return _genWriteStr('DoubleLE', valueStr);


        case 'varuint': return `helper.writeVarUInt(buffer, ${valueStr});`;

        case 'string': return `helper.writeString(buffer, ${valueStr}, strEnc);`;
        case 'buffer': return `helper.writeBuffer(buffer, ${valueStr});`;
    }
    return undefined;
}

function getBuiltinReadString(dataType, valueStr)
{
    return valueStr + ' = ' + READ_BUILTIN_TYPES[dataType];
}

function getBuiltinSizeString(dataType, valueStr)
{
    const funcMap = BufferPlus._getTypeFuncMap(dataType);
    if (!funcMap || !funcMap.size)
        return '';
    if (typeof funcMap.size === 'number')
        return `byteCount += ${funcMap.size};`;

    switch (dataType.toLowerCase())
    {
        case 'string':
            return `byteCount += helper.byteLengthString(${valueStr}, strEnc);`;
        case 'buffer':
            return `byteCount += helper.byteLengthBuffer(${valueStr}, strEnc);`;
        case 'varint':
            return `byteCount += helper.byteLengthVarInt(${valueStr});`;
        case 'varuint':
            return `byteCount += helper.byteLengthVarUInt(${valueStr});`;
    }
    return `byteCount += helper.getDataTypeByteLength(${valueStr}, '${dataType}', strEnc);`;
}

function getDataTypeFunctionString(type, key)
{
    const dataType = type.trim();
    const typeLowerCase = dataType.toLowerCase();
    const readObjStr = 'data.' + key.trim();
    const writeObjStr = 'json.' + key.trim();
    // const readObjStr = `data['${key.trim()}']`;
    // const writeObjStr = `json['${key.trim()}']`;

    // case insensitive
    if (READ_BUILTIN_TYPES.hasOwnProperty(typeLowerCase))
    {
        return {
            read: getBuiltinReadString(typeLowerCase, readObjStr),
            write: getBuiltinWriteString(typeLowerCase, writeObjStr),
            size: getBuiltinSizeString(dataType, writeObjStr),
        };
    }
    // case sensitive
    else if (BufferPlus.hasCustomType(dataType))
    {
        return {
            read: `${readObjStr} = buffer.read${dataType}();`,
            write: `buffer.write${dataType}(${writeObjStr});`,
            size: getBuiltinSizeString(dataType, writeObjStr),
        };
    }
    else
    {
        throw new TypeError('Invalid data type:' + dataType);
    }
}

module.exports = BufferSchema;
