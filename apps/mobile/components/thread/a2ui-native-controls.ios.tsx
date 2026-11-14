import { Button, Host, TextField, useNativeState } from "@expo/ui/swift-ui";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { View } from "react-native";

const fillRow = { width: "100%" as const, minWidth: 0, alignSelf: "stretch" as const };

export function A2uiTextField({
  label,
  value,
  onChangeText,
  testID,
  multiline,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  testID: string;
  multiline?: boolean;
}) {
  const text = useNativeState(value);
  useEffect(() => {
    text.set(value);
  }, [text, value]);
  return (
    <View testID={testID} style={fillRow}>
      <Host matchContents style={fillRow}>
        <TextField
          text={text}
          placeholder={label}
          axis={multiline ? "vertical" : "horizontal"}
          onTextChange={onChangeText}
        />
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
        <Button label={label} onPress={onPress} />
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
  return (
    <View
      testID={testID ?? "a2ui-native-sheet"}
      accessibilityLabel={label}
      style={{ ...fillRow, gap: 8 }}
    >
      {children}
    </View>
  );
}
