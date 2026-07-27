import { 
  View, 
  Text, 
  StyleSheet, 
  Pressable,
  TextInput,
} from 'react-native';

import { useState, useRef } from 'react';
import { router } from 'expo-router';



export default function Index() {


  const [password, setPassword] = useState('');

  const inputRef = useRef<TextInput>(null);



  const handlePress = () => {
    inputRef.current?.focus();
  };



  const handleChange = (text:string) => {

    // 只允许数字
    const value = text.replace(/[^0-9]/g,'');

    setPassword(value);


    // 6位自动进入聊天
    if(value.length === 6){

      setTimeout(()=>{

        router.replace('/chat');

      },200);

    }

  };



  return (

    <View style={styles.container}>


      <View style={styles.center}>


        <Text style={styles.logo}>
          🌊
        </Text>


        <Text style={styles.title}>
          小C ♡ 小天使
        </Text>



        <Pressable
          style={styles.dotsContainer}
          onPress={handlePress}
        >


          {
            Array.from({length:6}).map((_,index)=>(

              <Text
                key={index}
                style={[
                  styles.dot,
                  index < password.length && styles.activeDot
                ]}
              >

                {index < password.length ? '●' : '○'}

              </Text>

            ))
          }


        </Pressable>



        <TextInput

          ref={inputRef}

          style={styles.hiddenInput}

          keyboardType="number-pad"

          maxLength={6}

          value={password}

          onChangeText={handleChange}

          autoFocus={false}

        />


      </View>


    </View>

  );
}




const styles = StyleSheet.create({


  container:{
    flex:1,
    backgroundColor:'#FAFAF8',
  },


  center:{
    flex:1,
    justifyContent:'center',
    alignItems:'center',
  },


  logo:{
    fontSize:42,
    marginBottom:24,
  },


  title:{
    fontSize:22,
    color:'#666666',
    fontWeight:'400',
    letterSpacing:1,
    marginBottom:45,
  },


  dotsContainer:{
    flexDirection:'row',
    gap:12,
    padding:20,
  },


  dot:{
    fontSize:25,
    color:'#999999',
  },


  activeDot:{
    color:'#555555',
  },


  hiddenInput:{
    position:'absolute',
    width:1,
    height:1,
    opacity:0,
  },


});