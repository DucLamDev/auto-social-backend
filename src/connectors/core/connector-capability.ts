export interface ConnectorCapability {
  text: boolean;
  image: boolean;
  video: boolean;
  article: boolean;
  delete: boolean;
  schedule: boolean;
  analytics: boolean;
  maxText?: number;
  maxImages?: number;
}
