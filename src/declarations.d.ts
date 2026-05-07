/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-extraneous-class */
/**
 * Type declarations for Alibaba Cloud SDK packages.
 * These packages ship .d.ts files but don't reference them in package.json.
 */
declare module "@alicloud/kms20160120" {
  export class GetSecretValueRequest {
    constructor(props?: { secretName?: string; versionId?: string });
    secretName?: string;
    versionId?: string;
    validate(): void;
  }

  export class GetSecretValueResponse {
    body?: {
      secretData?: string;
      secretDataType?: string;
      secretName?: string;
      versionId?: string;
    };
  }

  export default class Client {
    constructor(config: any);
    getSecretValueWithOptions(
      request: GetSecretValueRequest,
      runtime: any,
    ): Promise<GetSecretValueResponse>;
    getSecretValue(
      request: GetSecretValueRequest,
    ): Promise<GetSecretValueResponse>;
  }
}

declare module "@alicloud/openapi-client" {
  export class Config {
    accessKeyId?: string;
    accessKeySecret?: string;
    regionId?: string;
    endpoint?: string;
    constructor(props?: Partial<Config>);
  }

  export class OpenApiRequest {
    constructor(props?: any);
  }

  export class Params {
    constructor(props?: any);
  }

  export class GlobalParameters {
    constructor(props?: any);
  }

  export default class Client {
    constructor(config: Config);
  }
}

declare module "@alicloud/tea-util" {
  export class RuntimeOptions {
    readTimeout?: number;
    connectTimeout?: number;
    constructor(props?: Partial<RuntimeOptions>);
  }

  export class ExtendsParameters {
    constructor(props?: any);
  }
}
