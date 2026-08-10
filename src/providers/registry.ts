import type {
  ProviderAdapter,
  ProviderCancelRequest,
  ProviderCapability,
  ProviderDescriptor,
  ProviderEstimate,
  ProviderEstimateRequest,
  ProviderHealth,
  ProviderJob,
  ProviderPollRequest,
  ProviderSubmitRequest,
} from "./types.js";
import { ProviderConfigurationError, assertProviderCapability } from "./types.js";
import { descriptorSnapshot } from "./utils.js";

/**
 * In-memory wiring for provider adapters. Only descriptor snapshots are meant
 * to be persisted; adapter instances and resolved credentials never are.
 */
export class ProviderRegistry {
  readonly #adapters = new Map<string, ProviderAdapter>();
  readonly #descriptors = new Map<string, ProviderDescriptor>();

  constructor(adapters: readonly ProviderAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: ProviderAdapter): this {
    const id = adapter.descriptor.id;
    if (this.#adapters.has(id)) {
      throw new ProviderConfigurationError(`Provider adapter ${id} is already registered`);
    }
    this.#validateDescriptor(adapter.descriptor);
    this.#adapters.set(id, adapter);
    this.#descriptors.set(id, descriptorSnapshot(adapter.descriptor));
    return this;
  }

  /** Register discovery metadata for an optional provider with no installed adapter. */
  registerDescriptor(descriptor: ProviderDescriptor): this {
    if (this.#descriptors.has(descriptor.id)) {
      throw new ProviderConfigurationError(`Provider descriptor ${descriptor.id} is already registered`);
    }
    this.#validateDescriptor(descriptor);
    this.#descriptors.set(descriptor.id, descriptorSnapshot(descriptor));
    return this;
  }

  unregister(providerId: string): boolean {
    const hadAdapter = this.#adapters.delete(providerId);
    const hadDescriptor = this.#descriptors.delete(providerId);
    return hadAdapter || hadDescriptor;
  }

  hasAdapter(providerId: string): boolean {
    return this.#adapters.has(providerId);
  }

  get(providerId: string): ProviderAdapter {
    const adapter = this.#adapters.get(providerId);
    if (!adapter) {
      const descriptor = this.#descriptors.get(providerId);
      if (descriptor?.optional) {
        throw new ProviderConfigurationError(
          `Optional provider ${providerId} is described but its adapter is not installed`,
        );
      }
      throw new ProviderConfigurationError(`Unknown provider adapter ${providerId}`);
    }
    return adapter;
  }

  descriptor(providerId: string): ProviderDescriptor {
    const descriptor = this.#descriptors.get(providerId);
    if (!descriptor) throw new ProviderConfigurationError(`Unknown provider ${providerId}`);
    return descriptorSnapshot(descriptor);
  }

  descriptors(): readonly ProviderDescriptor[] {
    return [...this.#descriptors.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(descriptorSnapshot);
  }

  /** JSON-safe discovery snapshot suitable for configuration persistence. */
  snapshot(): { readonly providers: readonly ProviderDescriptor[] } {
    return { providers: this.descriptors() };
  }

  providersFor(capability: ProviderCapability, installedOnly = true): readonly ProviderDescriptor[] {
    return this.descriptors().filter(
      (descriptor) =>
        descriptor.capabilities.includes(capability) &&
        (!installedOnly || this.#adapters.has(descriptor.id)),
    );
  }

  async capabilities(providerId?: string): Promise<readonly ProviderCapability[]> {
    if (providerId) return this.get(providerId).capabilities();
    const capabilities = new Set<ProviderCapability>();
    for (const adapter of this.#adapters.values()) {
      for (const capability of await adapter.capabilities()) capabilities.add(capability);
    }
    return [...capabilities].sort();
  }

  async health(providerId: string): Promise<ProviderHealth>;
  async health(): Promise<readonly ProviderHealth[]>;
  async health(providerId?: string): Promise<ProviderHealth | readonly ProviderHealth[]> {
    if (providerId) {
      const adapter = this.#adapters.get(providerId);
      if (adapter) return adapter.health();
      const descriptor = this.#descriptors.get(providerId);
      if (!descriptor) throw new ProviderConfigurationError(`Unknown provider ${providerId}`);
      return this.#unconfiguredHealth(descriptor);
    }
    return Promise.all(
      [...this.#descriptors.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((descriptor) =>
          this.#adapters.get(descriptor.id)?.health() ??
            Promise.resolve(this.#unconfiguredHealth(descriptor)),
        ),
    );
  }

  estimate(providerId: string, request: ProviderEstimateRequest): Promise<ProviderEstimate> {
    const adapter = this.#adapterFor(providerId, request.capability);
    return adapter.estimate(request);
  }

  submit(providerId: string, request: ProviderSubmitRequest): Promise<ProviderJob> {
    const adapter = this.#adapterFor(providerId, request.capability);
    return adapter.submit(request);
  }

  poll(providerId: string, request: ProviderPollRequest): Promise<ProviderJob> {
    const adapter = this.#adapterFor(providerId, request.capability);
    return adapter.poll(request);
  }

  cancel(providerId: string, request: ProviderCancelRequest): Promise<ProviderJob> {
    const adapter = this.#adapterFor(providerId, request.capability);
    if (!adapter.cancel) {
      throw new ProviderConfigurationError(`Provider ${providerId} does not support cancellation`);
    }
    return adapter.cancel(request);
  }

  #adapterFor(providerId: string, capability: ProviderCapability): ProviderAdapter {
    const adapter = this.get(providerId);
    assertProviderCapability(adapter.descriptor, capability);
    return adapter;
  }

  #validateDescriptor(descriptor: ProviderDescriptor): void {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(descriptor.id)) {
      throw new ProviderConfigurationError(`Invalid provider id ${JSON.stringify(descriptor.id)}`);
    }
    if (!descriptor.displayName.trim()) {
      throw new ProviderConfigurationError(`Provider ${descriptor.id} needs a display name`);
    }
    if (new Set(descriptor.capabilities).size !== descriptor.capabilities.length) {
      throw new ProviderConfigurationError(`Provider ${descriptor.id} declares duplicate capabilities`);
    }
    const modelIds = descriptor.models?.map((model) => model.id) ?? [];
    if (new Set(modelIds).size !== modelIds.length) {
      throw new ProviderConfigurationError(`Provider ${descriptor.id} declares duplicate model ids`);
    }
  }

  #unconfiguredHealth(descriptor: ProviderDescriptor): ProviderHealth {
    return {
      providerId: descriptor.id,
      status: "unconfigured",
      checkedAt: new Date().toISOString(),
      message: descriptor.optional
        ? "Optional provider adapter is not installed or enabled"
        : "Provider adapter is not enabled",
    };
  }
}
