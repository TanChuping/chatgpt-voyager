export const PLAIN_TEXT_BEFORE_SEND_EVENT = 'gv:plain-text-before-send';
export const PLAIN_TEXT_NATIVE_SEND_ATTRIBUTE = 'data-gv-plain-text-native-send';

export interface PlainTextBeforeSendDetail {
  input: HTMLTextAreaElement;
}
