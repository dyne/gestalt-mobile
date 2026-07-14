export interface Clock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};
