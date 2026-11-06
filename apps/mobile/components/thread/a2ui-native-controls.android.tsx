import {
  Host,
  ModalBottomSheet,
  OutlinedTextField,
  RNHostView,
  TextButton,
  useNativeState,
} from "@expo/ui/jetpack-compose";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { View } from "react-native";

export function A2uiTextField({
  label,
  value,
  onChangeText,
  testID,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  testID: string;
}) {
  const text = useNativeState(value);
  useEffect(() => {
    text.set(value);
  }, [text, value]);
  return (
    <View testID={testID}>
      <Host matchContents>
        <OutlinedTextField value={text} onValueChange={onChangeText}>
          <OutlinedTextField.Label>{label}</OutlinedTextField.Label>
        </OutlinedTextField>
      </Host>
    </View>
  );
}

export function A2uiButton({
  label,
  onPress,
  testID,
}: {
  label: string;
  onPress: () => void;
  testID: string;
}) {
  return (
    <View testID={testID}>
      <Host matchContents>
        <TextButton onClick={onPress}>{label}</TextButton>
      </Host>
    </View>
  );
}

export function A2uiSheet({
  children,
  testID,
  label,
}: {
  children: ReactNode;
  testID?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(true);
  if (!open) {
    return (
      <View testID={testID ?? "a2ui-native-sheet"}>
        <Host matchContents>
          <TextButton onClick={() => setOpen(true)}>{label ?? ""}</TextButton>
        </Host>
      </View>
    );
  }
  return (
    <View testID={testID ?? "a2ui-native-sheet"}>
      <Host matchContents>
        <ModalBottomSheet onDismissRequest={() => setOpen(false)} skipPartiallyExpanded>
          <RNHostView matchContents>
            <View style={{ gap: 8 }}>{children}</View>
          </RNHostView>
        </ModalBottomSheet>
      </Host>
    </View>
  );
}
