export class VmCoverageProvider {
  getSources(
    url: string,
    onTransform: (...args: any[]) => unknown,
    functions?: unknown[],
  ): Promise<{ code: string; map?: unknown }>;
}
