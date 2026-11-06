import type { ReactNode } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

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
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ fontSize: 13 }}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        testID={testID}
        value={value}
        onChangeText={onChangeText}
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
    <View testID={testID ?? "a2ui-native-sheet"} accessibilityLabel={label}>
      {children}
    </View>
  );
}
