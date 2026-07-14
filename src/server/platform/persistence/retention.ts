export const eventRetention = 2000;
export function retainedSequences(sequences: number[]): number[] {
  return sequences.slice(-eventRetention);
}
