declare const provider: {
  takeCoverage(options: unknown): Promise<{
    result: Array<{ url: string; startOffset?: number }>;
  }>;
};
export default provider;
