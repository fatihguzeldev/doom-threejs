export default class OPL3 {
  outputChannelNumber: number;
  readonly registers: Int32Array;
  read(output: Float32Array | Int16Array, seek?: number): Float32Array | Int16Array;
  write(bank: number, address: number, data: number): void;
}
