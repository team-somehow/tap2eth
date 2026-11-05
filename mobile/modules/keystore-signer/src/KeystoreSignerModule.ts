import { requireNativeModule } from "expo";

type KeystoreSigner = {
  hasKey(alias: string): boolean;
  deleteKey(alias: string): void;
  biometricsAvailable(): boolean;
  generateKey(alias: string): string; // base64 SPKI
  sign(alias: string, dataB64: string, title: string, subtitle: string): Promise<string>; // base64 DER
};

export default requireNativeModule<KeystoreSigner>("KeystoreSigner");
