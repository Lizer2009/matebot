import {
  BottomSheet,
  Button,
  Host,
  RNHostView,
  TextField,
  useNativeState,
} from "@expo/ui/swift-ui";
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
        <TextField text={text} placeholder={label} onTextChange={onChangeText} />
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
  const [presented, setPresented] = useState(true);
  return (
    <View testID={testID ?? "a2ui-native-sheet"}>
      <Host matchContents>
        <BottomSheet
          isPresented={presented}
          onIsPresentedChange={setPresented}
          fitToContents
          anchor={
            presented || !label ? undefined : (
              <Button label={label} onPress={() => setPresented(true)} />
            )
          }
        >
          <RNHostView matchContents>
            <View style={{ gap: 8 }}>{children}</View>
          </RNHostView>
        </BottomSheet>
      </Host>
    </View>
  );
}
