import type { ReactNode } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

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
  return (
    <View style={{ gap: 4, width: "100%", minWidth: 0 }}>
      <Text style={{ fontSize: 13 }}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        testID={testID}
        value={value}
        multiline={multiline}
        onChangeText={onChangeText}
        style={{ width: "100%" }}
      />
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
    <Pressable accessibilityRole="button" testID={testID} onPress={onPress}>
      <Text>{label}</Text>
    </Pressable>
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
      style={{ width: "100%", minWidth: 0, gap: 8 }}
    >
      {children}
    </View>
  );
}
